import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '../../errors.js';
import { audit } from '../../services/audit.js';
import { parse, requireAdmin, resolveOrg, sendCsv, type Services } from '../context.js';

export async function alertAuditRoutes(app: FastifyInstance, s: Services) {
  app.get('/alerts', async (req) => {
    const admin = await requireAdmin(s, req, 'read');
    const org = await resolveOrg(s, req, admin);
    const q = parse(
      z.object({ deviceId: z.uuid().optional(), unacknowledged: z.enum(['true', 'false']).optional(), limit: z.coerce.number().int().min(1).max(500).default(100), orgId: z.string().optional() }),
      req.query,
    );
    const { rows } = await s.db.query(
      `select a.id, a.device_id as "deviceId", d.display_name as "deviceName", a.kind, a.payload, a.ts,
              a.acknowledged_at as "acknowledgedAt"
       from alerts a join devices d on d.id = a.device_id
       where a.org_id = $1 and ($2::uuid is null or a.device_id = $2) and ($3::boolean is not true or a.acknowledged_at is null)
       order by a.ts desc limit $4`,
      [org.id, q.deviceId ?? null, q.unacknowledged === 'true', q.limit],
    );
    return { alerts: rows };
  });

  app.post<{ Params: { id: string } }>('/alerts/:id/ack', async (req) => {
    const admin = await requireAdmin(s, req, 'command');
    const org = await resolveOrg(s, req, admin);
    const res = await s.db.query(
      'update alerts set acknowledged_at = now(), acknowledged_by = $3 where id = $1 and org_id = $2 and acknowledged_at is null',
      [req.params.id, org.id, admin.id],
    );
    if (!res.rowCount) throw notFound('alert');
    await audit(s.db, { orgId: org.id, actor: { type: 'admin', id: admin.id }, action: 'alert.acknowledged', targetType: 'alert', targetId: req.params.id, ip: req.ip });
    return { ok: true };
  });

  /** Audit log (spec §6): who did what, when. `?format=csv` exports. */
  app.get('/audit', async (req, reply) => {
    const admin = await requireAdmin(s, req, 'read');
    const org = await resolveOrg(s, req, admin);
    const q = parse(
      z.object({
        action: z.string().max(80).optional(),
        targetId: z.string().max(64).optional(),
        before: z.coerce.number().int().optional(),
        limit: z.coerce.number().int().min(1).max(5000).default(200),
        format: z.enum(['json', 'csv']).default('json'),
        orgId: z.string().optional(),
      }),
      req.query,
    );
    const { rows } = await s.db.query<{ id: string; ts: Date; actor_type: string; actor_id: string; actor_email: string | null; action: string; target_type: string | null; target_id: string | null; meta: unknown; ip: string | null }>(
      `select e.id::text, e.ts, e.actor_type, e.actor_id, a.email as actor_email, e.action, e.target_type, e.target_id, e.meta, e.ip
       from audit_events e left join admins a on e.actor_type = 'admin' and a.id::text = e.actor_id
       where e.org_id = $1 and ($2::text is null or e.action like $2 || '%') and ($3::text is null or e.target_id = $3)
         and ($4::bigint is null or e.id < $4)
       order by e.id desc limit $5`,
      [org.id, q.action ?? null, q.targetId ?? null, q.before ?? null, q.limit],
    );
    if (q.format === 'csv') {
      await audit(s.db, { orgId: org.id, actor: { type: 'admin', id: admin.id }, action: 'audit.exported', meta: { rows: rows.length }, ip: req.ip });
      return sendCsv(reply, 'redcore-audit.csv', ['id', 'ts', 'actor_type', 'actor_id', 'actor_email', 'action', 'target_type', 'target_id', 'ip', 'meta'],
        rows.map((r) => [r.id, r.ts.toISOString(), r.actor_type, r.actor_id, r.actor_email, r.action, r.target_type, r.target_id, r.ip, r.meta]));
    }
    return {
      events: rows.map((r) => ({ id: r.id, ts: r.ts, actorType: r.actor_type, actorId: r.actor_id, actorEmail: r.actor_email, action: r.action, targetType: r.target_type, targetId: r.target_id, meta: r.meta, ip: r.ip })),
      nextBefore: rows.length === q.limit ? rows[rows.length - 1]!.id : null,
    };
  });
}
