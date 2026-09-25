import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Queryable } from '../db.js';
import { withDerived, type DesiredState } from '../domain/desired-state.js';
import { notFound } from '../errors.js';
import type { CommandSigner } from '../security/command-signer.js';
import { audit, type Actor } from './audit.js';

export const COMMAND_TYPES = ['APPLY_STATE', 'LOCATE', 'ANTI_THEFT_SNAPSHOT', 'SHOW_MESSAGE', 'SYNC_INVENTORY'] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

export type CommandActor = { type: 'admin'; id: string } | { type: 'system'; id: string };

export interface CommandRow {
  id: string;
  org_id: string;
  device_id: string;
  type: CommandType;
  payload: Record<string, unknown>;
  envelope: string;
  signature: string;
  status: 'pending' | 'delivered' | 'succeeded' | 'failed' | 'expired' | 'cancelled';
  issued_by: string | null;
  issued_by_system: string | null;
  idempotency_key: string | null;
  attempts: number;
  expires_at: Date;
  delivered_at: Date | null;
  ack_ts: Date | null;
  result: Record<string, unknown> | null;
  created_at: Date;
}

export interface SignedEnvelope {
  envelope: string;
  signature: string;
}

/** Commands that are never delivered this many times without an ack are marked failed. */
export const MAX_DELIVERY_ATTEMPTS = 8;

/**
 * Durable, idempotent, signed command queue plus the desired-state
 * reconciliation engine (spec §7).
 *
 * Persistent device state (kiosk lock, wallpaper, policy) lives in
 * `devices.desired_state`. Every change bumps `desired_version` and enqueues an
 * APPLY_STATE command carrying the full signed state, so the latest command
 * always supersedes older ones. Heartbeats also return the signed state when
 * the device reports an older version, so a device that missed or let a
 * command expire still converges. One-shot actions (locate, message, …) are
 * plain commands.
 */
export class CommandService {
  constructor(
    private readonly signer: CommandSigner,
    private readonly ttlHours: number,
  ) {}

  signState(deviceId: string, state: DesiredState): SignedEnvelope {
    const envelope = JSON.stringify({ v: 1, kind: 'state', deviceId, version: state.version, state, issuedAt: new Date().toISOString() });
    return { envelope, signature: this.signer.sign(envelope) };
  }

  async enqueue(
    q: Queryable,
    input: {
      orgId: string;
      deviceId: string;
      type: CommandType;
      payload: Record<string, unknown>;
      actor: CommandActor;
      idempotencyKey?: string | undefined;
      ttlHours?: number;
    },
  ): Promise<{ command: CommandRow; created: boolean }> {
    if (input.idempotencyKey) {
      const existing = await q.query<CommandRow>(
        'select * from commands where device_id = $1 and idempotency_key = $2',
        [input.deviceId, input.idempotencyKey],
      );
      if (existing.rows[0]) return { command: existing.rows[0], created: false };
    }
    const id = randomUUID();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + (input.ttlHours ?? this.ttlHours) * 3_600_000);
    const envelope = JSON.stringify({
      v: 1,
      kind: 'command',
      id,
      deviceId: input.deviceId,
      type: input.type,
      payload: input.payload,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    const signature = this.signer.sign(envelope);
    const res = await q.query<CommandRow>(
      `insert into commands (id, org_id, device_id, type, payload, envelope, signature, issued_by, issued_by_system,
                             idempotency_key, expires_at, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       on conflict (device_id, idempotency_key) do nothing
       returning *`,
      [
        id,
        input.orgId,
        input.deviceId,
        input.type,
        input.payload,
        envelope,
        signature,
        input.actor.type === 'admin' ? input.actor.id : null,
        input.actor.type === 'system' ? input.actor.id : null,
        input.idempotencyKey ?? null,
        expiresAt,
        issuedAt,
      ],
    );
    if (res.rows[0]) return { command: res.rows[0], created: true };
    // Lost an idempotency race with a concurrent request.
    const winner = await q.query<CommandRow>('select * from commands where device_id = $1 and idempotency_key = $2', [
      input.deviceId,
      input.idempotencyKey,
    ]);
    return { command: winner.rows[0]!, created: false };
  }

  /**
   * Applies `mutate` to the device's desired state under a row lock. Returns
   * `changed: false` (and enqueues nothing) when the mutation is a no-op, which
   * makes repeated lock/unlock requests idempotent.
   */
  async mutateState(
    q: Queryable,
    input: {
      deviceId: string;
      actor: CommandActor;
      action: string;
      mutate: (s: DesiredState) => DesiredState | Promise<DesiredState>;
      idempotencyKey?: string | undefined;
      ip?: string | undefined;
      meta?: Record<string, unknown>;
    },
  ): Promise<{ state: DesiredState; changed: boolean; command: CommandRow | null; fcmToken: string | null }> {
    const dev = await q.query<{ id: string; org_id: string; desired_state: DesiredState; fcm_token: string | null }>(
      "select id, org_id, desired_state, fcm_token from devices where id = $1 and status = 'active' for update",
      [input.deviceId],
    );
    const device = dev.rows[0];
    if (!device) throw notFound('device');

    if (input.idempotencyKey) {
      const prior = await q.query<CommandRow>('select * from commands where device_id = $1 and idempotency_key = $2', [
        device.id,
        input.idempotencyKey,
      ]);
      if (prior.rows[0]) return { state: device.desired_state, changed: false, command: prior.rows[0], fcmToken: device.fcm_token };
    }

    const current = device.desired_state;
    // Round-trip through JSON so optional `undefined` fields compare like stored JSONB.
    const next: DesiredState = JSON.parse(
      JSON.stringify(withDerived({ ...(await input.mutate(structuredClone(current))), version: current.version })),
    );
    if (isDeepStrictEqual(next, current)) {
      return { state: current, changed: false, command: null, fcmToken: device.fcm_token };
    }
    next.version = current.version + 1;

    await q.query('update devices set desired_state = $2, desired_version = $3 where id = $1', [device.id, next, next.version]);
    // A newer full state supersedes any undelivered older one.
    await q.query(
      "update commands set status = 'cancelled' where device_id = $1 and type = 'APPLY_STATE' and status in ('pending', 'delivered')",
      [device.id],
    );
    const { command } = await this.enqueue(q, {
      orgId: device.org_id,
      deviceId: device.id,
      type: 'APPLY_STATE',
      payload: { version: next.version, state: next },
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
    });
    await audit(q, {
      orgId: device.org_id,
      actor: input.actor as Actor,
      action: input.action,
      targetType: 'device',
      targetId: device.id,
      meta: { desiredVersion: next.version, commandId: command.id, ...input.meta },
      ...(input.ip ? { ip: input.ip } : {}),
    });
    return { state: next, changed: true, command, fcmToken: device.fcm_token };
  }

  /**
   * Hands the device its due commands, oldest first. Delivered-but-unacked
   * commands become due again after a backoff of 1, 2, 4 … 60 minutes.
   */
  async pull(q: Queryable, deviceId: string, limit = 20): Promise<CommandRow[]> {
    await q.query(
      `update commands set status = 'failed', result = '{"error":"max_delivery_attempts"}'
       where device_id = $1 and status = 'delivered' and attempts >= $2 and next_attempt_at <= now()`,
      [deviceId, MAX_DELIVERY_ATTEMPTS],
    );
    const res = await q.query<CommandRow>(
      `with due as (
         select id from commands
         where device_id = $1 and status in ('pending', 'delivered') and next_attempt_at <= now() and expires_at > now()
         order by created_at
         limit $2
         for update skip locked
       )
       update commands c set
         status = 'delivered',
         delivered_at = coalesce(c.delivered_at, now()),
         attempts = c.attempts + 1,
         next_attempt_at = now() + make_interval(mins => least(60, power(2, c.attempts)::int))
       from due where c.id = due.id
       returning c.*`,
      [deviceId, limit],
    );
    return res.rows.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
  }

  async ack(
    q: Queryable,
    deviceId: string,
    commandId: string,
    outcome: { status: 'succeeded' | 'failed'; result?: Record<string, unknown> | undefined },
  ): Promise<CommandRow> {
    const res = await q.query<CommandRow>(
      // Merge so an attachment uploaded before the ack (anti-theft snapshot) is kept.
      `update commands set status = $3, ack_ts = now(), result = coalesce(result, '{}'::jsonb) || coalesce($4::jsonb, '{}'::jsonb)
       where id = $1 and device_id = $2 and status in ('pending', 'delivered')
       returning *`,
      [commandId, deviceId, outcome.status, outcome.result ?? null],
    );
    if (res.rows[0]) return res.rows[0];
    // Acks are idempotent: a retried ack returns the stored outcome.
    const existing = await q.query<CommandRow>('select * from commands where id = $1 and device_id = $2', [commandId, deviceId]);
    if (!existing.rows[0]) throw notFound('command');
    return existing.rows[0];
  }

  async expireStale(q: Queryable): Promise<number> {
    const res = await q.query(
      "update commands set status = 'expired' where status in ('pending', 'delivered') and expires_at <= now()",
    );
    return res.rowCount ?? 0;
  }
}

/** Public view of a command for the device (never exposes internal bookkeeping). */
export const toDeviceCommand = (c: CommandRow) => ({ id: c.id, type: c.type, envelope: c.envelope, signature: c.signature });

export const toAdminCommand = (c: CommandRow) => ({
  id: c.id,
  type: c.type,
  status: c.status,
  payload: c.type === 'APPLY_STATE' ? { version: (c.payload as { version?: number }).version } : c.payload,
  issuedBy: c.issued_by,
  issuedBySystem: c.issued_by_system,
  attempts: c.attempts,
  createdAt: c.created_at,
  deliveredAt: c.delivered_at,
  ackAt: c.ack_ts,
  expiresAt: c.expires_at,
  result: c.result,
});
