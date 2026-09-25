import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { createPool, type Db } from '../db.js';
import { HttpError } from '../errors.js';
import { CommandSigner } from '../security/command-signer.js';
import { JwtService } from '../security/jwt.js';
import { LocalBlobStore, type BlobStore } from '../services/blob-store.js';
import { CommandService } from '../services/commands.js';
import { GoogleAuth } from '../services/google-auth.js';
import { NoopIntegrityVerifier, PlayIntegrityVerifier, type IntegrityVerifier } from '../services/integrity.js';
import { JobRunner } from '../services/jobs.js';
import { LoanService } from '../services/loans.js';
import { FcmPushService, NoopPushService, type PushService } from '../services/push.js';
import type { Services } from './context.js';
import { agentRoutes } from './routes/agent.js';
import { alertAuditRoutes } from './routes/alerts-audit.js';
import { authRoutes } from './routes/auth.js';
import { deviceRoutes } from './routes/devices.js';
import { enrollmentRoutes } from './routes/enrollment.js';
import { loanRoutes } from './routes/loans.js';
import { orgRoutes } from './routes/org.js';
import { policyRoutes } from './routes/policies.js';
import { wallpaperRoutes } from './routes/wallpapers.js';

export interface BuildOptions {
  db?: Db;
  signer?: CommandSigner;
  push?: PushService;
  integrity?: IntegrityVerifier;
  blobs?: BlobStore;
  logger?: boolean;
}

export async function buildApp(cfg: Config, opts: BuildOptions = {}): Promise<{ app: FastifyInstance; services: Services; jobs: JobRunner }> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: cfg.LOG_LEVEL, redact: ['req.headers.authorization', 'req.headers["x-redcore-signature"]'] },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  const db = opts.db ?? createPool(cfg.DATABASE_URL);
  const google = cfg.GOOGLE_SERVICE_ACCOUNT_JSON ? new GoogleAuth(cfg.GOOGLE_SERVICE_ACCOUNT_JSON) : null;
  const signer =
    opts.signer ??
    CommandSigner.fromConfig({
      pem: cfg.COMMAND_SIGNING_KEY_PEM,
      file: cfg.COMMAND_SIGNING_KEY_FILE,
      allowEphemeral: cfg.NODE_ENV !== 'production',
    });
  if (!cfg.COMMAND_SIGNING_KEY_PEM && !cfg.COMMAND_SIGNING_KEY_FILE && !opts.signer) {
    app.log.warn('Using an ephemeral command signing key: enrolled agents will reject commands after a restart');
  }
  const projectId = cfg.FCM_PROJECT_ID ?? google?.projectId;
  const push = opts.push ?? (google && projectId ? new FcmPushService(google, projectId, app.log) : new NoopPushService());
  const integrity = opts.integrity ?? (google ? new PlayIntegrityVerifier(google, cfg.PLAY_INTEGRITY_PACKAGE_NAME) : new NoopIntegrityVerifier());
  const commands = new CommandService(signer, cfg.COMMAND_TTL_HOURS);
  const loans = new LoanService(commands);
  const services: Services = {
    cfg,
    db,
    jwt: new JwtService(cfg.JWT_SECRET, cfg.ACCESS_TOKEN_TTL_SECONDS),
    signer,
    commands,
    loans,
    push,
    blobs: opts.blobs ?? new LocalBlobStore(cfg.BLOB_DIR),
    integrity,
  };
  const jobs = new JobRunner(db, cfg, commands, loans, push, app.log);

  app.decorateRequest('admin', null);
  app.decorateRequest('device', null);

  // Keep the raw JSON body: the payment webhook HMAC is computed over the exact bytes.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const text = body as string;
    req.rawBody = text;
    if (!text) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new HttpError(400, 'INVALID_JSON'), undefined);
    }
  });
  app.addContentTypeParser(['image/jpeg', 'image/png', 'image/webp'], { parseAs: 'buffer', bodyLimit: 5 * 1024 * 1024 }, (_req, body, done) =>
    done(null, body),
  );

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: cfg.CORS_ORIGINS.split(',').map((o) => o.trim()), credentials: false });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute', allowList: cfg.NODE_ENV === 'test' ? () => true : undefined });
  await app.register(multipart, { limits: { fileSize: cfg.MAX_WALLPAPER_BYTES } });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message, details: err.details });
    }
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.statusCode === 429) return reply.code(429).send({ error: 'RATE_LIMITED', message: e.message });
    if (e.statusCode && e.statusCode < 500) {
      return reply.code(e.statusCode).send({ error: e.code ?? 'BAD_REQUEST', message: e.message });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'INTERNAL', message: 'Internal server error' });
  });

  app.get('/healthz', async () => {
    await db.query('select 1');
    return { ok: true };
  });

  await app.register(
    async (v1) => {
      v1.get('/meta', async () => ({ name: 'redcore', apiVersion: 1, commandPublicKey: signer.publicKeySpkiBase64() }));
      await authRoutes(v1, services);
      await orgRoutes(v1, services);
      await enrollmentRoutes(v1, services);
      await deviceRoutes(v1, services);
      await agentRoutes(v1, services);
      await policyRoutes(v1, services);
      await wallpaperRoutes(v1, services);
      await loanRoutes(v1, services);
      await alertAuditRoutes(v1, services);
    },
    { prefix: '/v1' },
  );

  app.addHook('onClose', async () => {
    jobs.stop();
    if (!opts.db) await db.end();
  });

  return { app, services, jobs };
}
