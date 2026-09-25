import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTx } from '../../db.js';
import { ROLES } from '../../domain/roles.js';
import { capabilitiesOf, phaseOf } from '../../domain/segments.js';
import { conflict, forbidden, notFound } from '../../errors.js';
import { hashPassword } from '../../security/passwords.js';
import { audit } from '../../services/audit.js';
import { parse, requireAdmin, requireCapability, resolveOrg, type Services } from '../context.js';

export async function orgRoutes(app: FastifyInstance, s: Services) {
  app.get('/org', async (req) => {
    const admin = await requireAdmin(s, req, 'read');
    const org = await resolveOrg(s, req, admin);
    return {
      id: org.id,
      type: org.type,
      name: org.name,
      region: org.region,
      retentionDays: org.retention_days,
      phase: phaseOf(org.type),
      capabilities: capabilitiesOf(org.type),
      webhookConfigured: !!org.webhook_secret,
      webhookUrl: org.type === 'emi' ? `${s.cfg.PUBLIC_BASE_URL}/v1/webhooks/payments/${org.id}` : null,
      commandPublicKey: s.signer.publicKeySpkiBase64(),
    };
  });

  app.patch('/org', async (req) => {
    const admin = await requireAdmin(s, req, 'manage');
    const org = await resolveOrg(s, req, admin);
    const body = parse(
      z.object({ name: z.string().min(2).max(120).optional(), retentionDays: z.number().int().min(1).max(365).optional() }),
      req.body,
    );
    await withTx(s.db, async (tx) => {
      await tx.query(
        'update organizations set name = coalesce($2, name), retention_days = coalesce($3, retention_days) where id = $1',
        [org.id, body.name ?? null, body.retentionDays ?? null],
      );
      await audit(tx, { orgId: org.id, actor: { type: 'admin', id: admin.id }, action: 'org.update', targetType: 'organization', targetId: org.id, meta: body, ip: req.ip });
    });
    return { ok: true };
  });

  /** Returns a new payment-webhook HMAC secret once; only its existence is shown afterwards. */
  app.post('/org/webhook-secret', async (req) => {
    const admin = await requireAdmin(s, req, 'manage');
    const org = await resolveOrg(s, req, admin);
    requireCapability(org, 'loans');
    const secret = `rcw_${randomBytes(32).toString('base64url')}`;
    await withTx(s.db, async (tx) => {
      await tx.query('update organizations set webhook_secret = $2 where id = $1', [org.id, secret]);
      await audit(tx, { orgId: org.id, actor: { type: 'admin', id: admin.id }, action: 'org.webhook_secret_rotated', targetType: 'organization', targetId: org.id, ip: req.ip });
    });
    return { secret, webhookUrl: `${s.cfg.PUBLIC_BASE_URL}/v1/webhooks/payments/${org.id}` };
  });

  app.get('/admins', async (req) => {
    const admin = await requireAdmin(s, req, 'manage');
    const org = await resolveOrg(s, req, admin);
    const { rows } = await s.db.query(
      `select id, role, email, display_name as "displayName", mfa_enabled as "mfaEnabled", disabled_at as "disabledAt", created_at as "createdAt"
       from admins where org_id = $1 order by created_at`,
      [org.id],
    );
    return { admins: rows };
  });

  app.post('/admins', async (req, reply) => {
    const admin = await requireAdmin(s, req, 'manage');
    const org = await resolveOrg(s, req, admin);
    const body = parse(
      z.object({
        email: z.email().transform((e) => e.toLowerCase()),
        displayName: z.string().min(1).max(120),
        role: z.enum(ROLES).exclude(['super_admin']),
        temporaryPassword: z.string().min(10).max(200),
      }),
      req.body,
    );
    const hash = await hashPassword(body.temporaryPassword);
    const created = await withTx(s.db, async (tx) => {
      if ((await tx.query('select 1 from admins where email = $1', [body.email])).rowCount) throw conflict('EMAIL_TAKEN');
      const row = (
        await tx.query<{ id: string }>(
          'insert into admins (org_id, role, email, display_name, password_hash) values ($1, $2, $3, $4, $5) returning id',
          [org.id, body.role, body.email, body.displayName, hash],
        )
      ).rows[0]!;
      await audit(tx, { orgId: org.id, actor: { type: 'admin', id: admin.id }, action: 'admin.create', targetType: 'admin', targetId: row.id, meta: { role: body.role, email: body.email }, ip: req.ip });
      return row;
    });
    reply.code(201);
    return { id: created.id };
  });

  app.delete<{ Params: { id: string } }>('/admins/:id', async (req) => {
    const admin = await requireAdmin(s, req, 'manage');
    const org = await resolveOrg(s, req, admin);
    if (req.params.id === admin.id) throw forbidden('CANNOT_DISABLE_SELF');
    await withTx(s.db, async (tx) => {
      const res = await tx.query(
        "update admins set disabled_at = now() where id = $1 and org_id = $2 and role <> 'super_admin' and disabled_at is null",
        [req.params.id, org.id],
      );
      if (!res.rowCount) throw notFound('admin');
      await tx.query('update refresh_tokens set revoked_at = now() where admin_id = $1 and revoked_at is null', [req.params.id]);
      await audit(tx, { orgId: org.id, actor: { type: 'admin', id: admin.id }, action: 'admin.disable', targetType: 'admin', targetId: req.params.id, ip: req.ip });
    });
    return { ok: true };
  });
}
