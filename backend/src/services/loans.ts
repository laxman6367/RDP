import type { Queryable } from '../db.js';
import { NO_KIOSK, type DesiredState, type DeviceNotice, type KioskOverride } from '../domain/desired-state.js';
import { evaluateLoan, type LoanEvaluation, type LoanTier } from '../domain/loan-rules.js';
import { audit } from './audit.js';
import type { CommandService } from './commands.js';

export interface LoanRow {
  id: string;
  org_id: string;
  device_id: string;
  account_ref: string;
  currency: string;
  reminder_days: number;
  grace_days: number;
  hard_lock_after_days: number;
  support_contact: string;
  payment_url: string | null;
  auto_lock_paused: boolean;
  status: 'active' | 'closed';
  last_tier: LoanTier;
  terms_disclosed_at: Date;
  created_at: Date;
}

export interface InstallmentRow {
  id: string;
  loan_id: string;
  seq: number;
  due_date: string;
  amount: number;
  paid_at: Date | null;
  payment_ref: string | null;
}

export const LOAN_RULES_ACTOR = { type: 'system', id: 'loan_rules' } as const;

export const todayUtc = (now = new Date()) => now.toISOString().slice(0, 10);

/**
 * Maps a loan tier onto the device's desired state (spec §5.2A).
 * Loan rules only ever touch locks they created (`source: 'loan_rule'`); a
 * lock placed by an admin is left alone so manual decisions are never undone
 * by automation.
 */
export function applyTier(state: DesiredState, loan: LoanRow, ev: LoanEvaluation): DesiredState {
  const ownsLock = state.kiosk.source === 'loan_rule' || state.kiosk.mode === 'none';
  const amountDue = ev.nextDueDate ? { amount: ev.amountDue, currency: loan.currency, dueDate: ev.nextDueDate } : undefined;
  const lock = (mode: 'payment_due' | 'payment_nag'): KioskOverride => ({
    mode,
    allowlist: [],
    message:
      mode === 'payment_due'
        ? `Your EMI payment is ${ev.overdueDays} day(s) overdue. Pay now to unlock this phone. Emergency calls are always available.`
        : `Your EMI payment is ${ev.overdueDays} day(s) overdue. Please pay to avoid the phone being locked.`,
    supportContact: loan.support_contact,
    ...(loan.payment_url ? { paymentUrl: loan.payment_url } : {}),
    ...(amountDue ? { amountDue } : {}),
    source: 'loan_rule',
  });

  let kiosk = state.kiosk;
  if (ownsLock) {
    if (loan.status === 'closed' || loan.auto_lock_paused || ev.tier === 'ok' || ev.tier === 'reminder') kiosk = NO_KIOSK;
    else kiosk = lock(ev.tier === 'hard_lock' ? 'payment_due' : 'payment_nag');
  }

  let notice: DeviceNotice | null = null;
  if (loan.status === 'active' && ev.tier !== 'ok' && ev.nextDueDate) {
    notice = {
      kind: 'payment_reminder',
      title: ev.overdueDays > 0 ? 'EMI payment overdue' : 'EMI payment due soon',
      body: `${loan.currency} ${ev.amountDue.toFixed(2)} due on ${ev.nextDueDate}. Support: ${loan.support_contact}`,
      dueDate: ev.nextDueDate,
      amount: ev.amountDue,
      currency: loan.currency,
    };
  }
  return { ...state, kiosk, notice };
}

export class LoanService {
  constructor(private readonly commands: CommandService) {}

  async load(q: Queryable, loanId: string): Promise<{ loan: LoanRow; installments: InstallmentRow[] } | null> {
    const loan = (await q.query<LoanRow>('select * from loans where id = $1', [loanId])).rows[0];
    if (!loan) return null;
    const installments = (
      await q.query<InstallmentRow>('select * from loan_installments where loan_id = $1 order by seq', [loanId])
    ).rows;
    return { loan, installments };
  }

  /** Re-evaluates one loan and reconciles its device. Returns the evaluation and the device's FCM token if state changed. */
  async evaluate(
    q: Queryable,
    loanId: string,
    now = new Date(),
  ): Promise<{ evaluation: LoanEvaluation; changed: boolean; fcmToken: string | null } | null> {
    const data = await this.load(q, loanId);
    if (!data) return null;
    const { loan, installments } = data;
    const evaluation = evaluateLoan(
      installments.map((i) => ({ dueDate: i.due_date, amount: i.amount, paidAt: i.paid_at })),
      { reminderDays: loan.reminder_days, graceDays: loan.grace_days, hardLockAfterDays: loan.hard_lock_after_days },
      todayUtc(now),
    );
    const res = await this.commands.mutateState(q, {
      deviceId: loan.device_id,
      actor: LOAN_RULES_ACTOR,
      action: `loan.tier.${evaluation.tier}`,
      mutate: (s) => applyTier(s, loan, evaluation),
      meta: { loanId: loan.id, accountRef: loan.account_ref, overdueDays: evaluation.overdueDays },
    });
    if (evaluation.tier !== loan.last_tier) {
      await q.query('update loans set last_tier = $2 where id = $1', [loan.id, evaluation.tier]);
      if (!res.changed) {
        await audit(q, {
          orgId: loan.org_id,
          actor: LOAN_RULES_ACTOR,
          action: `loan.tier.${evaluation.tier}`,
          targetType: 'loan',
          targetId: loan.id,
          meta: { from: loan.last_tier, overdueDays: evaluation.overdueDays },
        });
      }
    }
    return { evaluation, changed: res.changed, fcmToken: res.fcmToken };
  }

  /**
   * Allocates a payment to the oldest unpaid installments. Only installments
   * the payment fully covers are marked paid; any remainder is recorded on the
   * payment row for reconciliation by the financier.
   */
  async applyPayment(
    q: Queryable,
    loan: LoanRow,
    payment: { paymentRef: string; amount: number; paidAt: Date; raw: Record<string, unknown> },
  ): Promise<{ duplicate: boolean; installmentsPaid: number; closed: boolean }> {
    const inserted = await q.query(
      `insert into payments (org_id, loan_id, payment_ref, amount, paid_at, raw)
       values ($1, $2, $3, $4, $5, $6) on conflict (org_id, payment_ref) do nothing returning id`,
      [loan.org_id, loan.id, payment.paymentRef, payment.amount, payment.paidAt, payment.raw],
    );
    if (!inserted.rowCount) return { duplicate: true, installmentsPaid: 0, closed: loan.status === 'closed' };

    const unpaid = (
      await q.query<InstallmentRow>(
        'select * from loan_installments where loan_id = $1 and paid_at is null order by due_date, seq for update',
        [loan.id],
      )
    ).rows;
    let remaining = payment.amount;
    let installmentsPaid = 0;
    for (const inst of unpaid) {
      if (remaining + 1e-9 < inst.amount) break;
      remaining -= inst.amount;
      installmentsPaid++;
      await q.query('update loan_installments set paid_at = $2, payment_ref = $3 where id = $1', [
        inst.id,
        payment.paidAt,
        payment.paymentRef,
      ]);
    }
    const closed = installmentsPaid === unpaid.length && unpaid.length > 0;
    if (closed) await q.query("update loans set status = 'closed' where id = $1", [loan.id]);
    return { duplicate: false, installmentsPaid, closed };
  }
}
