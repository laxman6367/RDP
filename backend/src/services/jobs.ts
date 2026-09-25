import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import { withTx, type Db } from '../db.js';
import { audit } from './audit.js';
import type { CommandService } from './commands.js';
import type { LoanService } from './loans.js';
import type { PushService } from './push.js';

const JOB_LOCK_KEY = 727275;

/**
 * Periodic maintenance. Each run takes a Postgres advisory lock so that only
 * one replica does the work at a time.
 */
export class JobRunner {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly cfg: Config,
    private readonly commands: CommandService,
    private readonly loans: LoanService,
    private readonly push: PushService,
    private readonly log: FastifyBaseLogger,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => this.log.error({ err }, 'job run failed'));
    }, this.cfg.JOB_INTERVAL_SECONDS * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(now = new Date()): Promise<{ ran: boolean; expired: number; loansEvaluated: number; purged: number; offline: number }> {
    const client = await this.db.connect();
    try {
      const { rows } = await client.query<{ locked: boolean }>('select pg_try_advisory_lock($1) as locked', [JOB_LOCK_KEY]);
      if (!rows[0]?.locked) return { ran: false, expired: 0, loansEvaluated: 0, purged: 0, offline: 0 };
      try {
        const expired = await this.commands.expireStale(this.db);
        const loansEvaluated = await this.evaluateLoans(now);
        const purged = await this.purgeTelemetry();
        const offline = await this.flagOfflineDevices();
        return { ran: true, expired, loansEvaluated, purged, offline };
      } finally {
        await client.query('select pg_advisory_unlock($1)', [JOB_LOCK_KEY]);
      }
    } finally {
      client.release();
    }
  }

  /** EMI auto lock/unlock (spec §5.2A): overdue tiers are re-derived from the schedule every run. */
  async evaluateLoans(now: Date): Promise<number> {
    const { rows } = await this.db.query<{ id: string }>(
      "select l.id from loans l join devices d on d.id = l.device_id where d.status = 'active' and (l.status = 'active' or l.last_tier <> 'ok')",
    );
    for (const { id } of rows) {
      try {
        const res = await withTx(this.db, (tx) => this.loans.evaluate(tx, id, now));
        if (res?.changed) await this.push.wake(res.fcmToken, 'loan_rules');
      } catch (err) {
        this.log.error({ err, loanId: id }, 'loan evaluation failed');
      }
    }
    return rows.length;
  }

  /** Retention window enforcement (spec §3.4). */
  async purgeTelemetry(): Promise<number> {
    const res = await this.db.query('delete from telemetry where expires_at <= now()');
    return res.rowCount ?? 0;
  }

  /** Tamper signal (spec §10): a device that stops checking in may have had the agent disabled. */
  async flagOfflineDevices(): Promise<number> {
    const { rows } = await this.db.query<{ id: string; org_id: string; last_seen: Date }>(
      `select d.id, d.org_id, d.last_seen from devices d
       where d.status = 'active' and d.last_seen < now() - make_interval(hours => $1)
         and not exists (
           select 1 from alerts a where a.device_id = d.id and a.kind = 'tamper'
             and a.payload->>'reason' = 'offline' and a.ts > d.last_seen)`,
      [this.cfg.OFFLINE_ALERT_HOURS],
    );
    for (const d of rows) {
      await withTx(this.db, async (tx) => {
        await tx.query("insert into alerts (org_id, device_id, kind, payload) values ($1, $2, 'tamper', $3)", [
          d.org_id,
          d.id,
          { reason: 'offline', lastSeen: d.last_seen },
        ]);
        await audit(tx, {
          orgId: d.org_id,
          actor: { type: 'system', id: 'jobs' },
          action: 'device.offline',
          targetType: 'device',
          targetId: d.id,
          meta: { lastSeen: d.last_seen },
        });
      });
    }
    return rows.length;
  }
}
