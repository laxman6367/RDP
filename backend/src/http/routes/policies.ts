import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTx } from '../../db.js';
import { policySchemaForPhase, type EnterprisePolicy } from '../../domain/policy.js';
import { phaseOf } from '../../domain/segments.js';
import { badRequest, conflict, notFound } from '../../errors.js';
import { audit } from '../../services/audit.js';
import { stateWithPolicy, type PolicyRow } from '../../services/policy-apply.js';
import { parse, requireAdmin, resolveOrg, type OrgRow, type Services } from '../context.js';

const toPolicy = (p: PolicyRow & { device_count?: number }) => ({
  id: p.id,
  name: p.name,
  phase: p.phase,
  version: p.version,
  spec: p.spec,
  deviceCount: p.device_count ?? undefined,
  createdAt: p.created_at,
  updatedAt: p.updated_at,
});

export async function policyRoutes(app: FastifyInstance, s: Services) {
  async function validateSpec(org: OrgRow, raw: unknown) {
    const phase = phaseOf(org.type);
    const spec = parse(policySchemaForPhase(phase), raw);
    if (phase === 2) {
      const wp = (spec as EnterprisePolicy).wallpaper.defaultWallpaperId;
      if (wp && !(await s.db.query('select 1 from wallpapers where id = $1 and org_id = $2', [wp, org.id])).rowCount) {
        throw badRequest('WALLPAPER_NOT_FOUND', 'defaultWallpaperId does not exist in this organization');
      }
    }
    return { phase, spec };
  }

  /** Re-applies a policy to every device it is assigned to; returns the devices' FCM tokens to wake. */
  async function reapply(tx: Parameters<Parameters<typeof withTx>[1]>[0], policy: PolicyRow, adminId: string) {
    const { rows } = await tx.query<{ device_id: string }>(
      "select dp.device_id from device_policy dp join devices d on d.id = dp.device_id where dp.policy_id = $1 and d.status = 'active'",
      [policy.id],
    );
    const tokens: Array<string | null> = [];
    for (const { device_id } of rows) {
      const r = await s.commands.mutateState(tx, {
        deviceId: device_id,
        actor: { type: 'admin', id: adminId },
        action: 'device.policy_updated',
        mutate: (st) => stateWithPolicy(tx, device_id, st, policy),
        meta: { policyId: policy.id, policyVersion: policy.version },
      });
      if (r.changed) tokens.push(r.fcmToken);
    }
    return tokens;
  }

  app.get('/policies', async (req) => {
    const admin = await requireAdmin(s, req, 'read');
    const org = await resolveOrg(s, req, admin);
    const { rows } = await s.db.query<PolicyRow & { device_count: number }>(
      `select p.*, (select count(*)::int from device_policy dp where dp.policy_id = p.id) as device_count
       from policies p where p.org_id = $1 order by p.created_at`,
      [org.id],
    );
    return { policies: rows.map(toPolicy) };
  });

  /** The default (everything-off) spec for this org's phase — a starting point for the policy builder. */
  app.get('/policies/defaults', async (req) => {
    const admin = await requireAdmin(s, req, 'read');
    const org = await resolveOrg(s, req, admin);
    const phase = phaseOf(org.type);
    return { phase, spec: policySchemaForPhase(phase).parse({}) };
  });

  app.get<{ Params: { id: string } }>('/policies/:id', async (req) => {
    const admin = await requireAdmin(s, req, 'read');
    const org = await resolveOrg(s, req, admin);
    const p = (await s.db.query<PolicyRow>('select * from policies where id = $1 and org_id = $2', [req.params.id, org.id])).rows[0];
    if (!p) throw notFound('policy');
    return toPolicy(p);
  });

  app.post('/policies', async (req, reply) => {
    const admin = await requireAdmin(s, req, 'manage');
    const org = await resolveOrg(s, req, admin);
    const body = parse(z.object({ name: z.string().min(1).max(120), spec: z.unknown() }), req.body);
    const { phase, spec } = await validateSpec(org, body.spec ?? {});
    const p = await withTx(s.db, async (tx) => {
      const row = (
        await tx.query<PolicyRow>('insert into policies (org_id, name, phase, spec, created_by) values ($1, $2, $3, $4, $5) returning *', [
          org.id, body.name, phase, spec, admin.id,
        ])
      ).rows[0]!;
      await audit(tx, { orgId: org.id, actor: { type: 'admin', id: admin.id }, action: 'policy.create', targetType: 'policy', targetId: row.id, meta: { name: body.name }, ip: req.ip });
      return row;
    });
    reply.code(201);
    return toPolicy(p);
  });

  app.put<{ Params: { id: string } }>('/policies/:id', async (req) => {
    const admin = await requireAdmin(s, req, 'manage');
    const org = await resolveOrg(s, req, admin);
    const body = parse(z.object({ name: z.string().min(1).max(120).optional(), spec: z.unknown() }), req.body);
    const { spec } = await validateSpec(org, body.spec ?? {});
    const { policy, tokens } = await withTx(s.db, async (tx) => {
      const row = (
        await tx.query<PolicyRow>(
          `update policies set name = coalesce($3, name), spec = $4, version = version + 1, updated_at = now()
           where id = $1 and org_id = $2 returning *`,
          [req.params.id, org.id, body.name ?? null, spec],
        )
      ).rows[0];
      if (!row) throw notFound('policy');
      await audit(tx, { orgId: org.id, actor: { type: 'admin', id: admin.id }, action: 'policy.update', targetType: 'policy', targetId: row.id, meta: { version: row.version }, ip: req.ip });
      return { policy: row, tokens: await reapply(tx, row, admin.id) };
    });
    await Promise.all(tokens.map((t) => s.push.wake(t, 'policy_updated')));
    return { ...toPolicy(policy), devicesUpdated: tokens.length };
  });

  app.post<{ Params: { id: string } }>('/policies/:id/assign', async (req) => {
    const admin = await requireAdmin(s, req, 'manage');
    const org = await resolveOrg(s, req, admin);
    const { deviceIds } = parse(z.object({ deviceIds: z.array(z.uuid()).min(1).max(1000) }), req.body);
    const tokens = await withTx(s.db, async (tx) => {
      const policy = (await tx.query<PolicyRow>('select * from policies where id = $1 and org_id = $2', [req.params.id, org.id])).rows[0];
      if (!policy) throw notFound('policy');
      const owned = await tx.query<{ id: string }>("select id from devices where id = any($1) and org_id = $2 and status = 'active'", [deviceIds, org.id]);
      if (owned.rowCount !== new Set(deviceIds).size) throw notFound('device');
      for (const { id } of owned.rows) {
        await tx.query(
          'insert into device_policy (device_id, policy_id) values ($1, $2) on conflict (device_id) do update set policy_id = $2, applied_ts = now()',
          [id, policy.id],
        );
      }
      return reapply(tx, policy, admin.id);
    });
    await Promise.all(tokens.map((t) => s.push.wake(t, 'policy_assigned')));
    return { assigned: deviceIds.length, devicesUpdated: tokens.length };
  });

  app.delete<{ Params: { id: string } }>('/policies/:id', async (req) => {
    const admin = await requireAdmin(s, req, 'manage');
    const org = await resolveOrg(s, req, admin);
    await withTx(s.db, async (tx) => {
      const inUse = await tx.query('select 1 from device_policy where policy_id = $1 limit 1', [req.params.id]);
      if (inUse.rowCount) throw conflict('POLICY_IN_USE', 'Unassign this policy from all devices first');
      const res = await tx.query('delete from policies where id = $1 and org_id = $2', [req.params.id, org.id]);
      if (!res.rowCount) throw notFound('policy');
      await audit(tx, { orgId: org.id, actor: { type: 'admin', id: admin.id }, action: 'policy.delete', targetType: 'policy', targetId: req.params.id, ip: req.ip });
    });
    return { ok: true };
  });
}
