import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { loadConfig, type Config } from '../src/config.js';
import { createPool, migrate, type Db } from '../src/db.js';
import { buildApp } from '../src/http/app.js';
import type { Services } from '../src/http/context.js';
import { CommandSigner } from '../src/security/command-signer.js';
import type { JobRunner } from '../src/services/jobs.js';
import { NoopPushService } from '../src/services/push.js';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://redcore:redcore@localhost:5432/redcore_test';

export interface TestCtx {
  app: FastifyInstance;
  services: Services;
  jobs: JobRunner;
  db: Db;
  push: NoopPushService;
  signer: CommandSigner;
  cfg: Config;
  close: () => Promise<void>;
}

export async function resetDb(db: Db) {
  await db.query('drop schema public cascade; create schema public;');
  await migrate(db);
}

export async function createTestApp(overrides: Partial<Config> = {}): Promise<TestCtx> {
  const cfg = loadConfig(
    { NODE_ENV: 'test', DATABASE_URL: TEST_DB, JOBS_ENABLED: 'false', REQUIRE_MFA: 'false' } as NodeJS.ProcessEnv,
    { BLOB_DIR: mkdtempSync(path.join(tmpdir(), 'redcore-blobs-')), ...overrides },
  );
  const db = createPool(TEST_DB);
  await resetDb(db);
  const push = new NoopPushService();
  const signer = CommandSigner.generate();
  const { app, services, jobs } = await buildApp(cfg, { db, push, signer, logger: false });
  await app.ready();
  return {
    app, services, jobs, db, push, signer, cfg,
    close: async () => {
      await app.close();
      await db.end();
    },
  };
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export async function call(
  app: FastifyInstance,
  method: Method,
  url: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<LightMyRequestResponse & { json: () => any }> {
  return app.inject({
    method,
    url,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...opts.headers,
    },
    ...(opts.body !== undefined ? { payload: JSON.stringify(opts.body) } : {}),
  });
}

let counter = 0;

export async function registerOrg(app: FastifyInstance, orgType: 'family' | 'emi' | 'govt' | 'enterprise') {
  counter++;
  const email = `admin${counter}-${Date.now()}@example.com`;
  const res = await call(app, 'POST', '/v1/auth/register', {
    body: { orgName: `Org ${counter}`, orgType, email, password: 'correct-horse-battery', displayName: `Admin ${counter}` },
  });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.body}`);
  const me = await call(app, 'GET', '/v1/auth/me', { token: res.json().accessToken });
  return { token: res.json().accessToken as string, refreshToken: res.json().refreshToken as string, email, orgId: me.json().org.id as string, adminId: me.json().admin.id as string };
}

export const familyToken = (extra: Record<string, unknown> = {}) => ({
  subjectLabel: 'Riya',
  managementMode: 'device_owner',
  ownership: 'company',
  consentType: 'guardian_of_minor',
  subjectAge: 14,
  guardianAttestation: true,
  attesterName: 'Priya Sharma',
  ...extra,
});

export const enterpriseToken = (extra: Record<string, unknown> = {}) => ({
  subjectLabel: 'Handset 0042',
  ownerRef: 'LOAN-0042',
  managementMode: 'device_owner',
  ownership: 'company',
  consentType: 'company_owned',
  guardianAttestation: true,
  attesterName: 'Acme Finance Ops',
  ...extra,
});

export async function enrollDevice(
  app: FastifyInstance,
  adminToken: string,
  tokenBody: Record<string, unknown>,
  deviceExtra: Record<string, unknown> = {},
) {
  const t = await call(app, 'POST', '/v1/enrollment-tokens', { token: adminToken, body: tokenBody });
  if (t.statusCode !== 201) throw new Error(`token failed: ${t.body}`);
  const res = await call(app, 'POST', '/v1/enroll', {
    body: {
      code: t.json().code,
      holderAcknowledged: true,
      isDeviceOwner: tokenBody.managementMode === 'device_owner',
      isProfileOwner: tokenBody.managementMode === 'profile_owner',
      device: { manufacturer: 'Google', model: 'Pixel 8', osVersion: '15', sdkInt: 35, agentVersion: '0.1.0' },
      fcmToken: 'fcm-test-token',
      ...deviceExtra,
    },
  });
  if (res.statusCode !== 201) throw new Error(`enroll failed: ${res.body}`);
  return { deviceId: res.json().deviceId as string, credential: res.json().deviceCredential as string, enroll: res.json() };
}

export const heartbeat = (app: FastifyInstance, deviceId: string, credential: string, reportedVersion: number, extra: Record<string, unknown> = {}) =>
  call(app, 'POST', `/v1/devices/${deviceId}/heartbeat`, {
    token: credential,
    body: { reportedVersion, reportedState: { isDeviceOwner: true, adminActive: true }, clientTime: new Date().toISOString(), ...extra },
  });
