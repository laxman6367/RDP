export type LoanTier = 'ok' | 'reminder' | 'nag' | 'hard_lock';

export interface InstallmentLike {
  dueDate: string; // YYYY-MM-DD
  amount: number;
  paidAt: string | Date | null;
}

export interface LoanTerms {
  reminderDays: number;
  graceDays: number;
  hardLockAfterDays: number;
}

export interface LoanEvaluation {
  tier: LoanTier;
  overdueDays: number;
  nextDueDate: string | null;
  amountDue: number;
}

const DAY_MS = 86_400_000;
const dayNumber = (isoDate: string) => Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / DAY_MS);

/**
 * EMI lock tiers (spec §5.2A). Pure so it can be unit-tested and replayed:
 *  - ok:        nothing due within `reminderDays`
 *  - reminder:  due soon, or overdue within the grace period
 *  - nag:       overdue past grace — dismissible reminder screen (partial lock)
 *  - hard_lock: overdue >= hardLockAfterDays — payment-due kiosk lock
 */
export function evaluateLoan(installments: InstallmentLike[], terms: LoanTerms, today: string): LoanEvaluation {
  const unpaid = installments.filter((i) => !i.paidAt).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const oldest = unpaid[0];
  if (!oldest) return { tier: 'ok', overdueDays: 0, nextDueDate: null, amountDue: 0 };

  const t = dayNumber(today);
  const daysUntil = dayNumber(oldest.dueDate) - t;
  const overdueDays = Math.max(0, -daysUntil);
  const dueNow = unpaid.filter((i) => dayNumber(i.dueDate) <= t);
  const amountDue = round2((dueNow.length ? dueNow : [oldest]).reduce((s, i) => s + i.amount, 0));
  const base = { overdueDays, nextDueDate: oldest.dueDate, amountDue };

  if (daysUntil > terms.reminderDays) return { ...base, tier: 'ok' };
  if (overdueDays <= terms.graceDays) return { ...base, tier: 'reminder' };
  if (overdueDays < terms.hardLockAfterDays) return { ...base, tier: 'nag' };
  return { ...base, tier: 'hard_lock' };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
