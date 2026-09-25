import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTx } from '../../db.js';
import type { DesiredState } from '../../domain/desired-state.js';
import { ALERT_KINDS, alertAllowed, minimizePayload, TELEMETRY_KINDS, telemetryAllowed } from '../../domain/telemetry-rules.js';
import { badRequest, forbidden, notFound } from '../../errors.js';
import { audit } from '../../services/audit.js';
import { toDeviceCommand, type CommandRow } from '../../services/commands.js';
import type { WallpaperRow } from '../../services/policy-apply.js';
import { loadDeviceForAdmin, parse, requireAdmin, requireDevice, type DeviceRow, type OrgRow, type Services } from '../context.js';

type IdParams = { Params: { id: string } };
type CmdParams = { Params: { id: string; cid: string } };

/** How often the agent should check in when it gets no push (spec §7: never rely on push alone). */
export const POLL_INTERVAL_SECONDS = 15 * 60;

const reportedStateSchema = z
  .object({
    kioskMode: z.string().max(40).optional(),
    isDeviceOwner: z.boolean().optional(),
    isProfileOwner: z.boolean().optional(),
    adminActive: z.boolean().optional(),
    // Runtime/special permission status, e.g. { READ_SMS: 'denied' } — drives the console fallback UX (spec §4.5).
    permissions: z.record(z.string().max(80), z.enum(['granted', 'denied', 'not_requested', 'unavailable'])).optional(),
    appliedRestrictions: z.array(z.string().max(80)).max(100).optional(),
    wallpaperId: z.string().max(64).nullable().optional(),
    batteryPct: z.number().min(0).max(100).optional(),
    agentVersion: z.string().max(40).optional(),
    osVersion: z.string().max(40).optional(),
    errors: z.array(z.string().max(500)).max(20).optional(),
  })
  .loose();

async function raiseTamper(s: Services, device: DeviceRow, reason: string, meta: Record<string, unknown>) {
  const recent = await s.db.query(
    "select 1 from alerts where device_id = $1 and kind = 'tamper' and payload->>'reason' = $2 and ts > now() - interval '24 hours'",
    [device.id, reason],
  );
  if (recent.rowCount) return;
  await withTx(s.db, async (tx) => {
    await tx.query("insert into alerts (org_id, device_id, kind, payload) values ($1, $2, 'tamper', $3)", [device.org_id, device.id, { reason, ...meta }]);
    await audit(tx, { orgId: device.org_id, actor: { type: 'device', id: device.id }, action: `device.tamper.${reason}`, targetType: 'device', targetId: device.id, meta });
  });
}

export async function agentRoutes(app: FastifyInstance, s: Services) {
  app.post<IdParams>('/devices/:id/heartbeat', async (req) => {
    const device = await requireDevice(s, req, req.params.id);
    const body = parse(
      z.object({
        reportedVersion: z.number().int().min(0),
        reportedState: reportedStateSchema,
        fcmToken: z.string().max(4096).optional(),
        clientTime: z.iso.datetime({ offset: true }),
      }),
      req.body,
    );

    const skew = Math.abs(Date.parse(body.clientTime) - Date.now()) / 1000;
    const tamper: Array<[string, Record<string, unknown>]> = [];
    if (skew > s.cfg.MAX_CLOCK_SKEW_SECONDS) tamper.push(['clock_skew', { skewSeconds: Math.round(skew) }]);
    if (body.reportedState.adminActive === false) tamper.push(['admin_disabled', {}]);
    if (device.management_mode === 'device_owner' && body.reportedState.isDeviceOwner === false) tamper.push(['device_owner_removed', {}]);
    for (const [reason, meta] of tamper) await raiseTamper(s, device, reason, meta);

    const { rows } = await s.db.query<{ desired_version: number; desired_state: DesiredState; pending: number }>(
      `update devices set last_seen = now(), reported_state = $2, fcm_token = coalesce($3, fcm_token),
         agent_version = coalesce($4, agent_version), os_version = coalesce($5, os_version)
       where id = $1
       returning desired_version, desired_state,
         (select count(*)::int from commands c where c.device_id = devices.id and c.status in ('pending', 'delivered')
            and c.next_attempt_at <= now() and c.expires_at > now()) as pending`,
      [device.id, body.reportedState, body.fcmToken ?? null, body.reportedState.agentVersion ?? null, body.reportedState.osVersion ?? null],
    );
    const row = rows[0]!;
    return {
      serverTime: new Date().toISOString(),
      desiredVersion: row.desired_version,
      pendingCommands: row.pending,
      pollIntervalSeconds: POLL_INTERVAL_SECONDS,
      // Reconciliation: a device behind the desired version gets the full signed state.
      state: body.reportedVersion < row.desired_version ? s.commands.signState(device.id, row.desired_state) : null,
    };
  });

  app.get<IdParams>('/devices/:id/commands', async (req) => {
    const device = await requireDevice(s, req, req.params.id);
    const commands = await withTx(s.db, (tx) => s.commands.pull(tx, device.id));
    return { commands: commands.map(toDeviceCommand) };
  });

  app.post<CmdParams>('/devices/:id/commands/:cid/ack', async (req) => {
    const device = await requireDevice(s, req, req.params.id);
    const body = parse(
      z.object({ status: z.enum(['succeeded', 'failed']), result: z.record(z.string(), z.unknown()).optional() }),
      req.body,
    );
    if (!/^[0-9a-f-]{36}$/i.test(req.params.cid)) throw notFound('command');
    return withTx(s.db, async (tx) => {
      const cmd = await s.commands.ack(tx, device.id, req.params.cid, body);
      if (cmd.type === 'APPLY_STATE' && cmd.status === 'succeeded') {
        const version = Number((cmd.payload as { version: number }).version);
        await tx.query('update devices set reported_version = greatest(reported_version, $2) where id = $1', [device.id, version]);
        const state = (cmd.payload as { state: DesiredState }).state;
        if (state.released) {
          // The agent has lifted its restrictions; revoke the credential.
          await tx.query("update devices set status = 'retired' where id = $1", [device.id]);
          await audit(tx, { orgId: device.org_id, actor: { type: 'device', id: device.id }, action: 'device.retired', targetType: 'device', targetId: device.id });
        }
      }
      if (cmd.type === 'ANTI_THEFT_SNAPSHOT' || cmd.type === 'LOCATE') {
        await audit(tx, { orgId: device.org_id, actor: { type: 'device', id: device.id }, action: `command.${cmd.type.toLowerCase()}.completed`, targetType: 'device', targetId: device.id, meta: { commandId: cmd.id, status: cmd.status } });
      }
      if (cmd.type === 'LOCATE' && cmd.status === 'succeeded' && body.result?.location) {
        const org = (await tx.query<OrgRow>('select retention_days from organizations where id = $1', [device.org_id])).rows[0]!;
        await tx.query(
          "insert into telemetry (org_id, device_id, kind, payload, ts, expires_at) values ($1, $2, 'location', $3, now(), now() + make_interval(days => $4))",
          [device.org_id, device.id, { ...(body.result.location as object), source: 'locate' }, org.retention_days],
        );
      }
      return { id: cmd.id, status: cmd.status };
    });
  });

  /** Upload for a disclosed anti-theft snapshot (spec §4.4). Only accepted for an open snapshot command. */
  app.post<CmdParams>('/devices/:id/commands/:cid/attachment', { bodyLimit: 5 * 1024 * 1024 }, async (req) => {
    const device = await requireDevice(s, req, req.params.id);
    const ct = String(req.headers['content-type'] ?? '');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(ct)) throw badRequest('UNSUPPORTED_MEDIA_TYPE');
    if (!Buffer.isBuffer(req.body)) throw badRequest('BODY_REQUIRED');
    const cmd = (
      await s.db.query<CommandRow>(
        "select * from commands where id = $1 and device_id = $2 and type = 'ANTI_THEFT_SNAPSHOT' and status in ('pending', 'delivered')",
        [req.params.cid, device.id],
      )
    ).rows[0];
    if (!cmd) throw notFound('open snapshot command');
    const key = `snapshots/${device.org_id}/${device.id}/${cmd.id}`;
    await s.blobs.put(key, req.body);
    await s.db.query("update commands set result = coalesce(result, '{}'::jsonb) || $2 where id = $1", [
      cmd.id,
      { attachment: { key, contentType: ct, size: req.body.length } },
    ]);
    return { ok: true };
  });

  app.get<CmdParams>('/devices/:id/commands/:cid/attachment', async (req, reply) => {
    const admin = await requireAdmin(s, req, 'read');
    const { device } = await loadDeviceForAdmin(s, admin, req.params.id);
    const cmd = (await s.db.query<CommandRow>('select * from commands where id = $1 and device_id = $2', [req.params.cid, device.id])).rows[0];
    const att = (cmd?.result as { attachment?: { key: string; contentType: string } } | null)?.attachment;
    if (!att) throw notFound('attachment');
    const data = await s.blobs.get(att.key);
    if (!data) throw notFound('attachment');
    await audit(s.db, { orgId: device.org_id, actor: { type: 'admin', id: admin.id }, action: 'command.attachment_viewed', targetType: 'device', targetId: device.id, meta: { commandId: cmd!.id }, ip: req.ip });
    reply.header('content-type', att.contentType).header('cache-control', 'private, no-store');
    return data;
  });

  app.post<IdParams>('/devices/:id/telemetry', { bodyLimit: 2 * 1024 * 1024 }, async (req) => {
    const device = await requireDevice(s, req, req.params.id);
    const body = parse(
      z.object({
        items: z
          .array(z.object({ kind: z.enum(TELEMETRY_KINDS), ts: z.iso.datetime({ offset: true }), payload: z.record(z.string(), z.unknown()) }))
          .min(1)
          .max(500),
      }),
      req.body,
    );
    const org = (await s.db.query<OrgRow>('select retention_days from organizations where id = $1', [device.org_id])).rows[0]!;
    const state = device.desired_state;
    const rejected: Array<{ index: number; kind: string; reason: string }> = [];
    const accepted: Array<[string, Record<string, unknown>, string]> = [];
    body.items.forEach((item, index) => {
      if (!telemetryAllowed(state, item.kind)) rejected.push({ index, kind: item.kind, reason: 'NOT_ENABLED_BY_POLICY' });
      else accepted.push([item.kind, minimizePayload(state, item.kind, item.payload), item.ts]);
    });
    if (accepted.length) {
      await s.db.query(
        `insert into telemetry (org_id, device_id, kind, payload, ts, expires_at)
         select $1, $2, t.kind, t.payload, t.ts, t.ts + make_interval(days => $3)
         from jsonb_to_recordset($4::jsonb) as t(kind text, payload jsonb, ts timestamptz)`,
        [device.org_id, device.id, org.retention_days, JSON.stringify(accepted.map(([kind, payload, ts]) => ({ kind, payload, ts })))],
      );
    }
    return { accepted: accepted.length, rejected };
  });

  app.post<IdParams>('/devices/:id/alerts', async (req, reply) => {
    const device = await requireDevice(s, req, req.params.id);
    const body = parse(
      z.object({ kind: z.enum(ALERT_KINDS), payload: z.record(z.string(), z.unknown()).default({}), ts: z.iso.datetime({ offset: true }).optional() }),
      req.body,
    );
    if (!alertAllowed(device.desired_state, body.kind)) throw forbidden('NOT_ENABLED_BY_POLICY');
    const row = (
      await s.db.query<{ id: string }>(
        'insert into alerts (org_id, device_id, kind, payload, ts) values ($1, $2, $3, $4, coalesce($5, now())) returning id',
        [device.org_id, device.id, body.kind, body.payload, body.ts ?? null],
      )
    ).rows[0]!;
    if (body.kind === 'tamper' || body.kind === 'sos') {
      await audit(s.db, { orgId: device.org_id, actor: { type: 'device', id: device.id }, action: `device.alert.${body.kind}`, targetType: 'device', targetId: device.id, meta: { alertId: row.id } });
    }
    reply.code(201);
    return { id: row.id };
  });

  app.get<{ Params: { id: string; wid: string } }>('/devices/:id/wallpapers/:wid', async (req, reply) => {
    const device = await requireDevice(s, req, req.params.id);
    if (!/^[0-9a-f-]{36}$/i.test(req.params.wid)) throw notFound('wallpaper');
    const wp = (await s.db.query<WallpaperRow>('select * from wallpapers where id = $1 and org_id = $2', [req.params.wid, device.org_id])).rows[0];
    if (!wp) throw notFound('wallpaper');
    const data = await s.blobs.get(wp.storage_key);
    if (!data) throw notFound('wallpaper');
    reply.header('content-type', wp.content_type).header('x-content-sha256', wp.sha256).header('cache-control', 'private, max-age=86400');
    return data;
  });
}
