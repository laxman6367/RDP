import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTx } from '../../db.js';
import { evaluateLoan } from '../../domain/loan-rules.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../../errors.js';
import { audit } from '../../services/audit.js';
import { todayUtc, type InstallmentRow, type LoanRow } from '../../services/loans.js';
import { loadDeviceForAdmin, parse, requireAdmin, requireCapability, resolveOrg, type OrgRow, type Services } from '../context.js';

const isoDate = z.iso.date();

function toLoan(loan: LoanRow, installments: InstallmentRow[], deviceName?: string) {
  const ev = evaluateLoan(
    installments.map((i) => ({ dueDate: i.due_date, amount: i.amount, paidAt: i.paid_at })),
    { reminderDays: loan.reminder_days, graceDays: loan.grace_days, hardLockAfterDays: loan.hard_lock_after_days },
    todayUtc(),
  );
  return {
    id: loan.id,
    deviceId: loan.device_id,
    deviceName: deviceName ?? null,
    accountRef: loan.account_ref,
    currency: loan.currency,
    status: loan.status,
    tier: ev.tier,
    overdueDays: ev.overdueDays,
    nextDueDate: ev.nextDueDate,
    amountDue: ev.amountDue,
    reminderDays: loan.reminder_days,
    graceDays: loan.grace_days,
    hardLockAfterDays: loan.hard_lock_after_days,
    supportContact: loan.support_contact,
    paymentUrl: loan.payment_url,
    autoLockPaused: loan.auto_lock_paused,
    termsDisclosedAt: loan.terms_disclosed_at,
    installments: installments.map((i) => ({ id: i.id, seq: i.seq, dueDate: i.due_date, amount: i.amount, paidAt: i.paid_at, paymentRef: i.payment_ref })),
  };
}

export async function loanRoutes(app: FastifyInstance, s: Services) {
  async function evaluateAndWake(loanId: string) {
    const res = await withTx(s.db, (tx) => s.loans.evaluate(tx, loanId));
    if (res?.changed) await s.push.wake(res.fcmToken, 'loan_rules');
    return res;
  }

  app.get('/loans', async (req) => {
    const admin = await requireAdmin(s, req, 'read');
    const org = await resolveOrg(s, req, admin);
    requireCapability(org, 'loans');
    const loans = (await s.db.query<LoanRow & { device_name: string }>(
      'select l.*, d.display_name as device_name from loans l join devices d on d.id = l.device_id where l.org_id = $1 order by l.created_at desc',
      [org.id],
    )).rows;
    const inst = (await s.db.query<InstallmentRow>(
      'select i.* from loan_installments i join loans l on l.id = i.loan_id where l.org_id = $1 order by i.seq',
      [org.id],
    )).rows;
    const byLoan = new Map<string, InstallmentRow[]>();
    for (const i of inst) byLoan.set(i.loan_id, [...(byLoan.get(i.loan_id) ?? []), i]);
    return { loans: loans.map((l) => toLoan(l, byLoan.get(l.id) ?? [], l.device_name)) };
  });

  app.post('/loans', async (req, reply) => {
    const admin = await requireAdmin(s, req, 'manage');
    const org = await resolveOrg(s, req, admin);
    requireCapability(org, 'loans');
    const body = parse(
      z
        .object({
          deviceId: z.uuid(),
          accountRef: z.string().min(1).max(120),
          currency: z.string().length(3).default('INR'),
          reminderDays: z.number().int().min(0).max(30).default(3),
          graceDays: z.number().int().min(0).max(60).default(2),
          hardLockAfterDays: z.number().int().min(1).max(365).default(7),
          supportContact: z.string().min(3).max(120),
          paymentUrl: z.url({ protocol: /^https$/ }).optional(),
          // Spec §5.2A: the locking terms must be disclosed to the buyer at sale.
          termsDisclosedAt: z.iso.datetime({ offset: true }),
          installments: z.array(z.object({ dueDate: isoDate, amount: z.number().positive().max(1e12) })).min(1).max(360),
        })
        .refine((b) => b.hardLockAfterDays > b.graceDays, { message: 'hardLockAfterDays must be greater than graceDays', path: ['hardLockAfterDays'] }),
      req.body,
    );
    const { device } = await loadDeviceForAdmin(s, admin, body.deviceId);
    if (device.org_id !== org.id) throw notFound('device');
    if (device.management_mode !== 'device_owner') throw forbidden('DEVICE_OWNER_REQUIRED');
    const loan = await withTx(s.db, async (tx) => {
      if ((await tx.query('select 1 from loans where device_id = $1', [device.id])).rowCount) throw conflict('DEVICE_HAS_LOAN');
      if ((await tx.query('select 1 from loans where org_id = $1 and account_ref = $2', [org.id, body.accountRef])).rowCount) throw conflict('ACCOUNT_REF_TAKEN');
      const row = (await tx.query<LoanRow>(
        `insert into loans (org_id, device_id, account_ref, currency, reminder_days, grace_days, hard_lock_after_days, support_contact, payment_url, terms_disclosed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
        [org.id, device.id, body.accountRef, body.currency.toUpperCase(), body.reminderDays, body.graceDays, body.hardLockAfterDays, body.supportContact, body.paymentUrl ?? null, body.termsDisclosedAt],
      )).rows[0]!;
      const sorted = [...body.installments].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
      for (const [i, inst] of sorted.entries()) {
        await tx.query('insert into loan_installments (loan_id, seq, due_date, amount) values ($1, $2, $3, $4)', [row.id, i + 1, inst.dueDate, inst.amount]);
      }
      await audit(tx, { orgId: org.id, actor: { type: 'admin', id: admin.id }, action: 'loan.create', targetType: 'loan', targetId: row.id, meta: { accountRef: body.accountRef, deviceId: device.id, installments: sorted.length }, ip: req.ip });
      return row;
    });
    await evaluateAndWake(loan.id);
    const data = await s.loans.load(s.db, loan.id);
    reply.code(201);
    return toLoan(data!.loan, data!.installments, device.display_name);
  });

  app.get<{ Params: { id: string } }>('/loans/:id', async (req) => {
    const admin = await requireAdmin(s, req, 'read');
    const org = await resolveOrg(s, req, admin);
    const data = await s.loans.load(s.db, req.params.id);
    if (!data || data.loan.org_id !== org.id) throw notFound('loan');
    const payments = await s.db.query('select payment_ref as "paymentRef", amount, paid_at as "paidAt", created_at as "receivedAt" from payments where loan_id = $1 order by paid_at desc', [data.loan.id]);
    return { ...toLoan(data.loan, data.installments), payments: payments.rows };
  });

  app.patch<{ Params: { id: string } }>('/loans/:id', async (req) => {
    const admin = await requireAdmin(s, req, 'manage');
    const org = await resolveOrg(s, req, admin);
    const body = parse(
      z.object({ autoLockPaused: z.boolean().optional(), supportContact: z.string().min(3).max(120).optional(), paymentUrl: z.url({ protocol: /^https$/ }).nullable().optional() }),
      req.body,
    );
    await withTx(s.db, async (tx) => {
      const res = await tx.query(
        `update loans set auto_lock_paused = coalesce($3, auto_lock_paused), support_contact = coalesce($4, support_contact),
           payment_url = case when $5::boolean then $6 else payment_url end
         where id = $1 and org_id = $2`,
        [req.params.id, org.id, body.autoLockPaused ?? null, body.supportContact ?? null, body.paymentUrl !== undefined, body.paymentUrl ?? null],
      );
      if (!res.rowCount) throw notFound('loan');
      await audit(tx, { orgId: org.id, actor: { type: 'admin', id: admin.id }, action: 'loan.update', targetType: 'loan', targetId: req.params.id, meta: body, ip: req.ip });
    });
    await evaluateAndWake(req.params.id);
    return { ok: true };
  });

  /** Manually record a payment (e.g. cash at a store); same allocation as the webhook. */
  app.post<{ Params: { id: string } }>('/loans/:id/payments', async (req) => {
    const admin = await requireAdmin(s, req, 'manage');
    const org = await resolveOrg(s, req, admin);
    const body = parse(z.object({ paymentRef: z.string().min(1).max(120), amount: z.number().positive(), paidAt: z.iso.datetime({ offset: true }).optional() }), req.body);
    const result = await withTx(s.db, async (tx) => {
      const loan = (await tx.query<LoanRow>('select * from loans where id = $1 and org_id = $2 for update', [req.params.id, org.id])).rows[0];
      if (!loan) throw notFound('loan');
      const r = await s.loans.applyPayment(tx, loan, { paymentRef: body.paymentRef, amount: body.amount, paidAt: body.paidAt ? new Date(body.paidAt) : new Date(), raw: { source: 'manual', adminId: admin.id } });
      await audit(tx, { orgId: org.id, actor: { type: 'admin', id: admin.id }, action: 'loan.payment_recorded', targetType: 'loan', targetId: loan.id, meta: { ...body, ...r }, ip: req.ip });
      return r;
    });
    const ev = await evaluateAndWake(req.params.id);
    return { ...result, tier: ev?.evaluation.tier };
  });

  /**
   * Payment gateway webhook (spec §5.2A, §7): payment received → auto-unlock.
   * Authenticated with an HMAC-SHA256 over `${timestamp}.${rawBody}` using the
   * org's webhook secret; requests older than 5 minutes are rejected (replay).
   */
  app.post<{ Params: { orgId: string } }>('/webhooks/payments/:orgId', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.orgId)) throw notFound('organization');
    const org = (await s.db.query<OrgRow>('select * from organizations where id = $1', [req.params.orgId])).rows[0];
    if (!org?.webhook_secret) throw notFound('organization');
    const ts = String(req.headers['x-redcore-timestamp'] ?? '');
    const sig = String(req.headers['x-redcore-signature'] ?? '').replace(/^sha256=/, '');
    const tsNum = Number(ts);
    if (!ts || !Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) throw unauthorized('WEBHOOK_TIMESTAMP_INVALID');
    const expected = createHmac('sha256', org.webhook_secret).update(`${ts}.${req.rawBody ?? ''}`).digest('hex');
    if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      throw unauthorized('WEBHOOK_SIGNATURE_INVALID');
    }
    const body = parse(
      z.object({ accountRef: z.string().min(1).max(120), paymentRef: z.string().min(1).max(120), amount: z.number().positive(), paidAt: z.iso.datetime({ offset: true }).optional(), currency: z.string().length(3).optional() }).loose(),
      req.body,
    );
    const result = await withTx(s.db, async (tx) => {
      const loan = (await tx.query<LoanRow>('select * from loans where org_id = $1 and account_ref = $2 for update', [org.id, body.accountRef])).rows[0];
      if (!loan) throw notFound('loan');
      if (body.currency && body.currency.toUpperCase() !== loan.currency) throw badRequest('CURRENCY_MISMATCH');
      const r = await s.loans.applyPayment(tx, loan, { paymentRef: body.paymentRef, amount: body.amount, paidAt: body.paidAt ? new Date(body.paidAt) : new Date(), raw: body });
      if (!r.duplicate) {
        await audit(tx, { orgId: org.id, actor: { type: 'webhook', id: 'payments' }, action: 'loan.payment_received', targetType: 'loan', targetId: loan.id, meta: { paymentRef: body.paymentRef, amount: body.amount, ...r }, ip: req.ip });
      }
      return { loanId: loan.id, ...r };
    });
    const ev = result.duplicate ? null : await evaluateAndWake(result.loanId);
    return { ok: true, duplicate: result.duplicate, installmentsPaid: result.installmentsPaid, loanClosed: result.closed, tier: ev?.evaluation.tier ?? null };
  });
}
