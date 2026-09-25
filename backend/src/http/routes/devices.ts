import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTx } from '../../db.js';
import { NO_KIOSK, type DesiredState, type KioskOverride } from '../../domain/desired-state.js';
import { packageName, type FamilyPolicy } from '../../domain/policy.js';
import { lockModeAllowed, phaseOf, type LockMode } from '../../domain/segments.js';
import { TELEMETRY_KINDS } from '../../domain/telemetry-rules.js';
import { buildTransparencyReport } from '../../domain/transparency.js';
import { badRequest, forbidden, notFound } from '../../errors.js';
import { audit } from '../../services/audit.js';
import { toAdminCommand, type CommandRow } from '../../services/commands.js';
import { stateWithPolicy, wallpaperPath, type PolicyRow, type WallpaperRow } from '../../services/policy-apply.js';
import {
  idempotencyKey,
  isDeviceCredential,
  loadDeviceForAdmin,
  parse,
  requireAdmin,
  requireCapability,
  requireDevice,
  resolveOrg,
  type AdminPrincipal,
  type DeviceRow,
  type OrgRow,
  type Services,
} from '../context.js';

type IdParams = { Params: { id: string } };

const lockBody = z.object({
  mode: z.enum(['kiosk', 'payment', 'full', 'study']),
  allowlist: z.array(packageName).max(50).default([]),
  message: z.string().max(280).optional(),
  supportContact: z.string().max(120).optional(),
  paymentUrl: z.url({ protocol: /^https$/ }).optional(),
});

const MODE_MAP: Record<LockMode, KioskOverride['mode']> = {
  kiosk: 'single_purpose',
  payment: 'payment_due',
  full: 'full',
  study: 'study',
};

export function deviceSummary(d: DeviceRow & { policy_name?: string | null }) {
  return {
    id: d.id,
    displayName: d.display_name,
    ownerRef: d.owner_ref,
    model: d.model,
    manufacturer: d.manufacturer,
    osVersion: d.os_version,
    agentVersion: d.agent_version,
    status: d.status,
    managementMode: d.management_mode,
    ownership: d.ownership,
    lastSeen: d.last_seen,
    enrolledAt: d.enroll_ts,
    kioskMode: d.desired_state.kiosk.mode,
    policyName: d.policy_name ?? null,
    desiredVersion: d.desired_version,
    reportedVersion: d.reported_version,
    // Compliant = the device has confirmed it applied the latest desired state.
    inSync: d.reported_version >= d.desired_version,
    integrity: (d.integrity_verdict as { status?: string } | null)?.status ?? 'unverified',
  };
}

export async function deviceRoutes(app: FastifyInstance, s: Services) {
  /** Runs a desired-state mutation for one device and wakes it. */
  async function mutate(
    req: FastifyRequest,
    admin: AdminPrincipal,
    device: DeviceRow,
    action: string,
    fn: (st: DesiredState) => DesiredState | Promise<DesiredState>,
    meta: Record<string, unknown> = {},
  ) {
    if (device.status !== 'active') throw badRequest('DEVICE_RETIRED');
    const res = await withTx(s.db, (tx) =>
      s.commands.mutateState(tx, {
        deviceId: device.id,
        actor: { type: 'admin', id: admin.id },
        action,
        mutate: fn,
        idempotencyKey: idempotencyKey(req),
        ip: req.ip,
        meta,
      }),
    );
    if (res.changed) await s.push.wake(res.fcmToken, action);
    return { changed: res.changed, desiredVersion: res.state.version, commandId: res.command?.id ?? null, kiosk: res.state.kiosk };
  }

  async function oneShot(
    req: FastifyRequest,
    admin: AdminPrincipal,
    device: DeviceRow,
    type: CommandRow['type'],
    payload: Record<string, unknown>,
  ) {
    if (device.status !== 'active') throw badRequest('DEVICE_RETIRED');
    const cmd = await withTx(s.db, async (tx) => {
      const { command, created } = await s.commands.enqueue(tx, {
        orgId: device.org_id,
        deviceId: device.id,
        type,
        payload,
        actor: { type: 'admin', id: admin.id },
        idempotencyKey: idempotencyKey(req),
        ttlHours: 1,
      });
      if (created) {
        await audit(tx, { orgId: device.org_id, actor: { type: 'admin', id: admin.id }, action: `command.${type.toLowerCase()}`, targetType: 'device', targetId: device.id, meta: { commandId: command.id }, ip: req.ip });
      }
      return command;
    });
    await s.push.wake(device.fcm_token, type);
    return { commandId: cmd.id, status: cmd.status };
  }

  function lockOverride(org: OrgRow, body: z.infer<typeof lockBody>, device: DeviceRow): KioskOverride {
    requireCapability(org, 'kiosk');
    if (!lockModeAllowed(org.type, body.mode)) {
      throw forbidden('LOCK_MODE_NOT_AVAILABLE', `Lock mode "${body.mode}" is not available for ${org.type} organizations`);
    }
    if (body.mode === 'kiosk' && body.allowlist.length === 0) throw badRequest('ALLOWLIST_REQUIRED', 'Kiosk mode needs at least one allowed app');
    if (body.mode === 'payment' && !body.supportContact) throw badRequest('SUPPORT_CONTACT_REQUIRED', 'Payment lock must show a support contact');
    if (device.management_mode !== 'device_owner' && body.mode !== 'study') {
      // Lock Task Mode for arbitrary packages needs Device Owner (spec §9).
      throw forbidden('DEVICE_OWNER_REQUIRED', 'Kiosk lock requires a Device Owner enrollment');
    }
    return {
      mode: MODE_MAP[body.mode],
      allowlist: body.mode === 'payment' || body.mode === 'full' ? [] : body.allowlist,
      ...(body.message ? { message: body.message } : {}),
      ...(body.supportContact ? { supportContact: body.supportContact } : {}),
      ...(body.paymentUrl ? { paymentUrl: body.paymentUrl } : {}),
      source: 'admin',
    };
  }

  app.get('/devices', async (req) => {
    const admin = await requireAdmin(s, req, 'read');
    const org = await resolveOrg(s, req, admin);
    const q = parse(
      z.object({
        q: z.string().max(120).optional(),
        status: z.enum(['active', 'retired']).optional(),
        locked: z.enum(['true', 'false']).optional(),
        orgId: z.string().optional(),
      }),
      req.query,
    );
    const { rows } = await s.db.query<DeviceRow & { policy_name: string | null }>(
      `select d.*, p.name as policy_name from devices d
       left join device_policy dp on dp.device_id = d.id left join policies p on p.id = dp.policy_id
       where d.org_id = $1
         and ($2::text is null or d.display_name ilike '%' || $2 || '%' or d.owner_ref ilike '%' || $2 || '%' or d.model ilike '%' || $2 || '%')
         and ($3::text is null or d.status = $3)
         and ($4::text is null or ((d.desired_state->'kiosk'->>'mode') <> 'none') = ($4 = 'true'))
       order by d.created_at desc limit 500`,
      [org.id, q.q ?? null, q.status ?? null, q.locked ?? null],
    );
    return { devices: rows.map(deviceSummary) };
  });

  app.get<IdParams>('/devices/:id', async (req) => {
    const admin = await requireAdmin(s, req, 'read');
    const { device, org } = await loadDeviceForAdmin(s, admin, req.params.id);
    const [consent, policy, loan] = await Promise.all([
      s.db.query('select id, type, attester_name as "attesterName", subject_label as "subjectLabel", subject_age as "subjectAge", coppa_applicable as "coppaApplicable", attestation_text as "attestationText", attestation_version as "attestationVersion", doc_ref as "docRef", device_acknowledged_at as "deviceAcknowledgedAt", device_holder_name as "deviceHolderName", created_at as "createdAt" from consents where id = $1', [device.consent_id]),
      s.db.query('select p.id, p.name, p.version, dp.applied_ts as "assignedAt" from device_policy dp join policies p on p.id = dp.policy_id where dp.device_id = $1', [device.id]),
      s.db.query('select id, account_ref as "accountRef", status, last_tier as "tier" from loans where device_id = $1', [device.id]),
    ]);
    return {
      device: deviceSummary(device),
      orgType: org.type,
      phase: phaseOf(org.type),
      desiredState: device.desired_state,
      reportedState: device.reported_state,
      integrity: device.integrity_verdict,
      consent: consent.rows[0] ?? null,
      policy: policy.rows[0] ?? null,
      loan: loan.rows[0] ?? null,
    };
  });

  app.get<IdParams>('/devices/:id/command-history', async (req) => {
    const admin = await requireAdmin(s, req, 'read');
    const { device } = await loadDeviceForAdmin(s, admin, req.params.id);
    const { rows } = await s.db.query<CommandRow>('select * from commands where device_id = $1 order by created_at desc limit 200', [device.id]);
    return { commands: rows.map(toAdminCommand) };
  });

  app.get<IdParams>('/devices/:id/audit', async (req) => {
    const admin = await requireAdmin(s, req, 'read');
    const { device } = await loadDeviceForAdmin(s, admin, req.params.id);
    const { rows } = await s.db.query(
      `select id, actor_type as "actorType", actor_id as "actorId", action, meta, ts from audit_events
       where target_type = 'device' and target_id = $1 order by ts desc limit 200`,
      [device.id],
    );
    return { events: rows };
  });

  app.post<IdParams>('/devices/:id/lock', async (req) => {
    const admin = await requireAdmin(s, req, 'command');
    const { device, org } = await loadDeviceForAdmin(s, admin, req.params.id);
    const body = parse(lockBody, req.body);
    const kiosk = lockOverride(org, body, device);
    return mutate(req, admin, device, 'device.lock', (st) => ({ ...st, kiosk }), { mode: body.mode });
  });

  app.post<IdParams>('/devices/:id/unlock', async (req) => {
    const admin = await requireAdmin(s, req, 'command');
    const { device, org } = await loadDeviceForAdmin(s, admin, req.params.id);
    requireCapability(org, 'kiosk');
    return mutate(req, admin, device, 'device.unlock', (st) => ({ ...st, kiosk: NO_KIOSK }));
  });

  /** Bulk lock/unlock for fleets and EMI portfolios (spec §6). */
  app.post('/devices/bulk/:action', async (req) => {
    const admin = await requireAdmin(s, req, 'command');
    const org = await resolveOrg(s, req, admin);
    requireCapability(org, 'kiosk');
    const action = parse(z.enum(['lock', 'unlock']), (req.params as { action: string }).action);
    const body = parse(z.object({ deviceIds: z.array(z.uuid()).min(1).max(500), lock: lockBody.optional() }), req.body);
    if (action === 'lock' && !body.lock) throw badRequest('LOCK_REQUIRED', 'Provide lock settings for a bulk lock');
    const results: Array<{ deviceId: string; ok: boolean; error?: string; changed?: boolean }> = [];
    for (const id of body.deviceIds) {
      try {
        const { device } = await loadDeviceForAdmin(s, admin, id);
        if (device.org_id !== org.id) throw notFound('device');
        const kiosk = action === 'lock' ? lockOverride(org, body.lock!, device) : NO_KIOSK;
        const r = await mutate(req, admin, device, `device.bulk_${action}`, (st) => ({ ...st, kiosk }));
        results.push({ deviceId: id, ok: true, changed: r.changed });
      } catch (err) {
        results.push({ deviceId: id, ok: false, error: (err as { code?: string }).code ?? 'ERROR' });
      }
    }
    return { results };
  });

  app.post<IdParams>('/devices/:id/wallpaper', async (req) => {
    const admin = await requireAdmin(s, req, 'command');
    const { device, org } = await loadDeviceForAdmin(s, admin, req.params.id);
    requireCapability(org, 'wallpaper');
    const body = parse(
      z.object({ wallpaperId: z.uuid().nullable(), target: z.enum(['home', 'lock', 'both']).default('both'), lockChange: z.boolean().default(false) }),
      req.body,
    );
    if (body.lockChange && device.management_mode !== 'device_owner') throw forbidden('DEVICE_OWNER_REQUIRED', 'Locking the wallpaper requires Device Owner');
    let wp: WallpaperRow | null = null;
    if (body.wallpaperId) {
      wp = (await s.db.query<WallpaperRow>('select * from wallpapers where id = $1 and org_id = $2', [body.wallpaperId, org.id])).rows[0] ?? null;
      if (!wp) throw notFound('wallpaper');
    }
    return mutate(req, admin, device, 'device.wallpaper', async (st) => {
      if (!wp) {
        // Clearing the device-specific wallpaper falls back to the policy default.
        const policy = st.policy
          ? (await s.db.query<PolicyRow>('select * from policies where id = $1', [st.policy.id])).rows[0] ?? null
          : null;
        return stateWithPolicy(s.db, device.id, { ...st, wallpaper: null }, policy);
      }
      return {
        ...st,
        wallpaper: { wallpaperId: wp.id, path: wallpaperPath(device.id, wp.id), sha256: wp.sha256, target: body.target, lockChange: body.lockChange, source: 'admin' },
      };
    }, { wallpaperId: body.wallpaperId, lockChange: body.lockChange });
  });

  app.put<IdParams>('/devices/:id/policy', async (req) => {
    const admin = await requireAdmin(s, req, 'manage');
    const { device, org } = await loadDeviceForAdmin(s, admin, req.params.id);
    const { policyId } = parse(z.object({ policyId: z.uuid().nullable() }), req.body);
    let policy: PolicyRow | null = null;
    if (policyId) {
      policy = (await s.db.query<PolicyRow>('select * from policies where id = $1 and org_id = $2', [policyId, org.id])).rows[0] ?? null;
      if (!policy) throw notFound('policy');
    }
    if (policyId) {
      await s.db.query(
        'insert into device_policy (device_id, policy_id) values ($1, $2) on conflict (device_id) do update set policy_id = $2, applied_ts = now()',
        [device.id, policyId],
      );
    } else {
      await s.db.query('delete from device_policy where device_id = $1', [device.id]);
    }
    return mutate(req, admin, device, 'device.policy_assigned', (st) => stateWithPolicy(s.db, device.id, st, policy), { policyId });
  });

  app.post<IdParams>('/devices/:id/message', async (req) => {
    const admin = await requireAdmin(s, req, 'command');
    const { device } = await loadDeviceForAdmin(s, admin, req.params.id);
    const { text } = parse(z.object({ text: z.string().min(1).max(500) }), req.body);
    return oneShot(req, admin, device, 'SHOW_MESSAGE', { text, from: admin.displayName });
  });

  app.post<IdParams>('/devices/:id/locate', async (req) => {
    const admin = await requireAdmin(s, req, 'command');
    const { device, org } = await loadDeviceForAdmin(s, admin, req.params.id);
    requireCapability(org, 'location');
    const p = device.desired_state.policy?.spec as FamilyPolicy | undefined;
    if (!p?.location.enabled) throw forbidden('LOCATION_NOT_ENABLED', 'Enable location in the device policy first');
    return oneShot(req, admin, device, 'LOCATE', {});
  });

  /** Lost-device mode (spec §4.4): a disclosed snapshot + location, shown to the holder and audited. */
  app.post<IdParams>('/devices/:id/lost', async (req) => {
    const admin = await requireAdmin(s, req, 'command');
    const { device, org } = await loadDeviceForAdmin(s, admin, req.params.id);
    requireCapability(org, 'anti_theft');
    const p = device.desired_state.policy?.spec as FamilyPolicy | undefined;
    if (!p?.antiTheft.enabled) throw forbidden('ANTI_THEFT_NOT_ENABLED', 'Enable lost-device mode in the device policy first');
    const { note } = parse(z.object({ note: z.string().max(280).optional() }), req.body ?? {});
    return oneShot(req, admin, device, 'ANTI_THEFT_SNAPSHOT', { visibleNotice: true, note: note ?? null });
  });

  app.post<IdParams>('/devices/:id/sync-inventory', async (req) => {
    const admin = await requireAdmin(s, req, 'command');
    const { device, org } = await loadDeviceForAdmin(s, admin, req.params.id);
    requireCapability(org, 'apps');
    return oneShot(req, admin, device, 'SYNC_INVENTORY', {});
  });

  app.get<IdParams>('/devices/:id/apps', async (req) => {
    const admin = await requireAdmin(s, req, 'read');
    const { device, org } = await loadDeviceForAdmin(s, admin, req.params.id);
    requireCapability(org, 'apps');
    const inv = await s.db.query<{ payload: { apps: Array<Record<string, unknown>> }; ts: Date }>(
      "select payload, ts from telemetry where device_id = $1 and kind = 'app_inventory' order by ts desc limit 1",
      [device.id],
    );
    const usage = await s.db.query<{ day: string; package: string; minutes: number; last_used: string | null }>(
      `select (payload->>'day') as day, u->>'package' as package, sum((u->>'minutes')::int)::int as minutes, max(u->>'lastUsed') as last_used
       from telemetry, jsonb_array_elements(payload->'usage') u
       where device_id = $1 and kind = 'app_usage' and ts > now() - interval '7 days'
       group by 1, 2 order by 1 desc, 3 desc`,
      [device.id],
    );
    const p = device.desired_state.policy?.spec as FamilyPolicy | undefined;
    const blocked = new Set(p?.apps.blocked ?? []);
    const limits = new Map((p?.apps.timeLimits ?? []).map((l) => [l.package, l.dailyMinutes]));
    const apps = (inv.rows[0]?.payload.apps ?? []).map((a) => ({
      ...a,
      blocked: blocked.has(String(a.package)),
      dailyLimitMinutes: limits.get(String(a.package)) ?? null,
    }));
    return { inventoryAt: inv.rows[0]?.ts ?? null, apps, usage: usage.rows };
  });

  app.get<IdParams>('/devices/:id/locations', async (req) => {
    const admin = await requireAdmin(s, req, 'read');
    const { device, org } = await loadDeviceForAdmin(s, admin, req.params.id);
    requireCapability(org, 'location');
    const q = parse(z.object({ since: z.iso.datetime().optional(), limit: z.coerce.number().int().min(1).max(2000).default(500) }), req.query);
    const { rows } = await s.db.query(
      `select payload, ts from telemetry where device_id = $1 and kind = 'location' and ($2::timestamptz is null or ts >= $2)
       order by ts desc limit $3`,
      [device.id, q.since ?? null, q.limit],
    );
    return { locations: rows.map((r) => ({ ...r.payload, ts: r.ts })) };
  });

  app.get<{ Params: { id: string; kind: string } }>('/devices/:id/telemetry/:kind', async (req) => {
    const admin = await requireAdmin(s, req, 'read');
    const { device, org } = await loadDeviceForAdmin(s, admin, req.params.id);
    const kind = parse(z.enum(TELEMETRY_KINDS), req.params.kind);
    requireCapability(org, kind === 'location' ? 'location' : kind.startsWith('app') ? 'apps' : 'comms');
    const { rows } = await s.db.query(
      'select payload, ts from telemetry where device_id = $1 and kind = $2 order by ts desc limit 500',
      [device.id, kind],
    );
    const permissions = (device.reported_state?.permissions ?? {}) as Record<string, string>;
    return { kind, items: rows, permissions };
  });

  /** Same report for the admin console and the device's own transparency screen (spec §3.2). */
  app.get<IdParams>('/devices/:id/transparency', async (req) => {
    let device: DeviceRow;
    let org: OrgRow;
    if (isDeviceCredential(req)) {
      device = await requireDevice(s, req, req.params.id);
      org = (await s.db.query<OrgRow>('select * from organizations where id = $1', [device.org_id])).rows[0]!;
    } else {
      const admin = await requireAdmin(s, req, 'read');
      ({ device, org } = await loadDeviceForAdmin(s, admin, req.params.id));
    }
    const consent = (await s.db.query<{ attester_name: string }>('select attester_name from consents where id = $1', [device.consent_id])).rows[0];
    return buildTransparencyReport({ orgType: org.type, orgName: org.name, managedBy: consent?.attester_name ?? org.name, state: device.desired_state });
  });

  /** Subject data export (spec §3.4). */
  app.get<IdParams>('/devices/:id/export', async (req, reply) => {
    const admin = await requireAdmin(s, req, 'manage');
    const { device } = await loadDeviceForAdmin(s, admin, req.params.id);
    const [consents, commands, telemetry, alerts, events] = await Promise.all([
      s.db.query('select * from consents where device_id = $1', [device.id]),
      s.db.query('select id, type, status, payload, created_at, ack_ts, result from commands where device_id = $1 order by created_at', [device.id]),
      s.db.query('select kind, payload, ts from telemetry where device_id = $1 order by ts', [device.id]),
      s.db.query('select kind, payload, ts, acknowledged_at from alerts where device_id = $1 order by ts', [device.id]),
      s.db.query("select actor_type, actor_id, action, meta, ts from audit_events where target_type = 'device' and target_id = $1 order by ts", [device.id]),
    ]);
    await audit(s.db, { orgId: device.org_id, actor: { type: 'admin', id: admin.id }, action: 'device.data_exported', targetType: 'device', targetId: device.id, ip: req.ip });
    const { credential_hash: _c, fcm_token: _f, ...safeDevice } = device as DeviceRow & { credential_hash?: string };
    reply.header('content-disposition', `attachment; filename="redcore-device-${device.id}.json"`);
    return {
      exportedAt: new Date().toISOString(),
      device: safeDevice,
      consents: consents.rows,
      commands: commands.rows,
      telemetry: telemetry.rows,
      alerts: alerts.rows,
      auditEvents: events.rows,
    };
  });

  /** Admin-initiated deletion of collected data (spec §3.4). */
  app.delete<IdParams>('/devices/:id/telemetry', async (req) => {
    const admin = await requireAdmin(s, req, 'manage');
    const { device } = await loadDeviceForAdmin(s, admin, req.params.id);
    const deleted = await withTx(s.db, async (tx) => {
      const t = await tx.query('delete from telemetry where device_id = $1', [device.id]);
      const a = await tx.query("delete from alerts where device_id = $1 and kind <> 'tamper'", [device.id]);
      await audit(tx, { orgId: device.org_id, actor: { type: 'admin', id: admin.id }, action: 'device.data_deleted', targetType: 'device', targetId: device.id, meta: { telemetry: t.rowCount, alerts: a.rowCount }, ip: req.ip });
      return { telemetry: t.rowCount ?? 0, alerts: a.rowCount ?? 0 };
    });
    return { deleted };
  });

  /** Releases management: the agent lifts every restriction, then the credential is revoked on its next ack. */
  app.post<IdParams>('/devices/:id/retire', async (req) => {
    const admin = await requireAdmin(s, req, 'manage');
    const { device } = await loadDeviceForAdmin(s, admin, req.params.id);
    const loan = await s.db.query("select 1 from loans where device_id = $1 and status = 'active'", [device.id]);
    if (loan.rowCount) throw forbidden('ACTIVE_LOAN', 'Close the loan before releasing this device');
    return mutate(req, admin, device, 'device.retire_requested', (st) => ({ ...st, kiosk: NO_KIOSK, wallpaper: null, notice: null, released: true }));
  });
}
