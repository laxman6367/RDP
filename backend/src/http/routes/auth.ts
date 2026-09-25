import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTx, type Queryable } from '../../db.js';
import type { Role } from '../../domain/roles.js';
import { ORG_TYPES } from '../../domain/segments.js';
import { badRequest, conflict, forbidden, unauthorized } from '../../errors.js';
import { hashPassword, verifyPassword } from '../../security/passwords.js';
import { randomToken, sha256Hex } from '../../security/tokens.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../../security/totp.js';
import { audit } from '../../services/audit.js';
import { authenticateAdmin, parse, type Services } from '../context.js';

const password = z.string().min(10, 'at least 10 characters').max(200);
const email = z.email().max(254).transform((e) => e.toLowerCase());

const authRateLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

interface AdminAuthRow {
  id: string;
  org_id: string | null;
  role: Role;
  email: string;
  display_name: string;
  password_hash: string;
  mfa_secret: string | null;
  mfa_enabled: boolean;
  disabled_at: Date | null;
}

export async function issueTokens(
  s: Services,
  admin: { id: string; org_id: string | null; role: Role },
  mfa: boolean,
  q: Queryable = s.db,
) {
  const accessToken = await s.jwt.sign({ sub: admin.id, org: admin.org_id, role: admin.role, mfa });
  const refreshToken = randomToken('rcr', 32);
  const expires = new Date(Date.now() + s.cfg.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  // The MFA state of the session is bound to the refresh token so refresh can't upgrade it.
  await q.query('insert into refresh_tokens (admin_id, token_hash, expires_at) values ($1, $2, $3)', [
    admin.id,
    sha256Hex(`${refreshToken}|mfa=${mfa}`),
    expires,
  ]);
  return { accessToken, refreshToken: `${refreshToken}.${mfa ? 1 : 0}`, expiresIn: s.cfg.ACCESS_TOKEN_TTL_SECONDS, mfa };
}

export async function authRoutes(app: FastifyInstance, s: Services) {
  app.post('/auth/register', authRateLimit, async (req, reply) => {
    if (!s.cfg.ALLOW_SELF_SIGNUP) throw forbidden('SIGNUP_DISABLED');
    const body = parse(
      z.object({
        orgName: z.string().min(2).max(120),
        orgType: z.enum(ORG_TYPES),
        region: z.string().min(2).max(8).default('IN'),
        email,
        password,
        displayName: z.string().min(1).max(120),
      }),
      req.body,
    );
    const hash = await hashPassword(body.password);
    const result = await withTx(s.db, async (tx) => {
      const exists = await tx.query('select 1 from admins where email = $1', [body.email]);
      if (exists.rowCount) throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
      const org = (
        await tx.query<{ id: string }>(
          'insert into organizations (type, name, region) values ($1, $2, $3) returning id',
          [body.orgType, body.orgName, body.region],
        )
      ).rows[0]!;
      const admin = (
        await tx.query<{ id: string; org_id: string; role: Role }>(
          `insert into admins (org_id, role, email, display_name, password_hash)
           values ($1, 'org_admin', $2, $3, $4) returning id, org_id, role`,
          [org.id, body.email, body.displayName, hash],
        )
      ).rows[0]!;
      await audit(tx, { orgId: org.id, actor: { type: 'admin', id: admin.id }, action: 'org.register', targetType: 'organization', targetId: org.id, ip: req.ip });
      return admin;
    });
    reply.code(201);
    return issueTokens(s, result, false);
  });

  app.post('/auth/login', authRateLimit, async (req) => {
    const body = parse(z.object({ email, password: z.string().max(200), totp: z.string().optional() }), req.body);
    const { rows } = await s.db.query<AdminAuthRow>('select * from admins where email = $1', [body.email]);
    const admin = rows[0];
    // Always run the hash comparison to keep timing uniform for unknown emails.
    const ok = await verifyPassword(body.password, admin?.password_hash ?? 'scrypt$16384$8$1$AAAA$AAAA');
    if (!admin || !ok || admin.disabled_at) {
      await audit(s.db, { orgId: admin?.org_id ?? null, actor: { type: 'admin', id: admin?.id ?? body.email }, action: 'auth.login_failed', ip: req.ip });
      throw unauthorized('INVALID_CREDENTIALS', 'Invalid email or password');
    }
    let mfa = false;
    if (admin.mfa_enabled) {
      if (!body.totp) throw unauthorized('MFA_CODE_REQUIRED', 'Enter the code from your authenticator app');
      if (!verifyTotp(admin.mfa_secret!, body.totp)) {
        await audit(s.db, { orgId: admin.org_id, actor: { type: 'admin', id: admin.id }, action: 'auth.mfa_failed', ip: req.ip });
        throw unauthorized('MFA_CODE_INVALID', 'Invalid authentication code');
      }
      mfa = true;
    }
    await audit(s.db, { orgId: admin.org_id, actor: { type: 'admin', id: admin.id }, action: 'auth.login', meta: { mfa }, ip: req.ip });
    return { ...(await issueTokens(s, admin, mfa)), mfaEnrollmentRequired: s.cfg.REQUIRE_MFA && !admin.mfa_enabled };
  });

  app.post('/auth/refresh', authRateLimit, async (req) => {
    const { refreshToken } = parse(z.object({ refreshToken: z.string().min(10) }), req.body);
    const [raw, mfaFlag] = refreshToken.split('.');
    const mfa = mfaFlag === '1';
    const hash = sha256Hex(`${raw}|mfa=${mfa}`);
    return withTx(s.db, async (tx) => {
      const { rows } = await tx.query<{ id: string; admin_id: string; expires_at: Date; revoked_at: Date | null }>(
        'select * from refresh_tokens where token_hash = $1 for update',
        [hash],
      );
      const rt = rows[0];
      if (!rt || rt.revoked_at || rt.expires_at < new Date()) throw unauthorized('REFRESH_TOKEN_INVALID');
      await tx.query('update refresh_tokens set revoked_at = now() where id = $1', [rt.id]);
      const admin = (await tx.query<AdminAuthRow>('select * from admins where id = $1', [rt.admin_id])).rows[0];
      if (!admin || admin.disabled_at) throw unauthorized('ADMIN_DISABLED');
      return issueTokens(s, admin, mfa, tx);
    });
  });

  app.post('/auth/logout', async (req) => {
    const { refreshToken } = parse(z.object({ refreshToken: z.string().min(10) }), req.body);
    const [raw, mfaFlag] = refreshToken.split('.');
    await s.db.query('update refresh_tokens set revoked_at = now() where token_hash = $1 and revoked_at is null', [
      sha256Hex(`${raw}|mfa=${mfaFlag === '1'}`),
    ]);
    return { ok: true };
  });

  app.get('/auth/me', async (req) => {
    const admin = await authenticateAdmin(s, req, true);
    const row = (await s.db.query<{ mfa_enabled: boolean }>('select mfa_enabled from admins where id = $1', [admin.id])).rows[0]!;
    const org = admin.orgId
      ? (await s.db.query('select id, type, name, region, retention_days from organizations where id = $1', [admin.orgId])).rows[0]
      : null;
    return { admin: { ...admin, mfaEnabled: row.mfa_enabled }, org, mfaRequired: s.cfg.REQUIRE_MFA };
  });

  app.post('/auth/mfa/setup', async (req) => {
    const admin = await authenticateAdmin(s, req, true);
    const row = (await s.db.query<{ mfa_enabled: boolean }>('select mfa_enabled from admins where id = $1', [admin.id])).rows[0]!;
    if (row.mfa_enabled) throw conflict('MFA_ALREADY_ENABLED');
    const secret = generateTotpSecret();
    await s.db.query('update admins set mfa_secret = $2 where id = $1', [admin.id, secret]);
    return { secret, otpauthUri: otpauthUri(secret, admin.email) };
  });

  app.post('/auth/mfa/enable', authRateLimit, async (req) => {
    const admin = await authenticateAdmin(s, req, true);
    const { code } = parse(z.object({ code: z.string() }), req.body);
    const row = (
      await s.db.query<AdminAuthRow>('select * from admins where id = $1', [admin.id])
    ).rows[0]!;
    if (row.mfa_enabled) throw conflict('MFA_ALREADY_ENABLED');
    if (!row.mfa_secret) throw badRequest('MFA_SETUP_REQUIRED', 'Call /auth/mfa/setup first');
    if (!verifyTotp(row.mfa_secret, code)) throw unauthorized('MFA_CODE_INVALID', 'Invalid authentication code');
    await s.db.query('update admins set mfa_enabled = true where id = $1', [admin.id]);
    await audit(s.db, { orgId: admin.orgId, actor: { type: 'admin', id: admin.id }, action: 'auth.mfa_enabled', ip: req.ip });
    return issueTokens(s, row, true);
  });
}
