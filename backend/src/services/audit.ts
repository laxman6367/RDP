import type { Queryable } from '../db.js';

export type Actor =
  | { type: 'admin'; id: string }
  | { type: 'device'; id: string }
  | { type: 'system'; id: string }
  | { type: 'webhook'; id: string };

export interface AuditEntry {
  orgId: string | null;
  actor: Actor;
  action: string;
  targetType?: string;
  targetId?: string;
  meta?: Record<string, unknown>;
  ip?: string;
}

/** Append-only audit trail (spec §3.5, §6, §7). Call inside the same transaction as the change. */
export async function audit(q: Queryable, e: AuditEntry): Promise<void> {
  await q.query(
    `insert into audit_events (org_id, actor_type, actor_id, action, target_type, target_id, meta, ip)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [e.orgId, e.actor.type, e.actor.id, e.action, e.targetType ?? null, e.targetId ?? null, e.meta ?? {}, e.ip ?? null],
  );
}
