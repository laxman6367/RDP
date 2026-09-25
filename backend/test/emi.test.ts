import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, createTestApp, enrollDevice, enterpriseToken, registerOrg, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(() => ctx.close());

const daysFromNow = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

async function emiDevice() {
  const org = await registerOrg(ctx.app, 'emi');
  const dev = await enrollDevice(ctx.app, org.token, enterpriseToken());
  const secret = (await call(ctx.app, 'POST', '/v1/org/webhook-secret', { token: org.token })).json().secret as string;
  return { ...org, ...dev, secret };
}

const createLoan = (token: string, deviceId: string, installments: Array<{ dueDate: string; amount: number }>, extra = {}) =>
  call(ctx.app, 'POST', '/v1/loans', {
    token,
    body: { deviceId, accountRef: `ACC-${deviceId.slice(0, 8)}`, supportContact: '+91 80 1234 5678', paymentUrl: 'https://pay.example.com/x', termsDisclosedAt: new Date().toISOString(), installments, ...extra },
  });

function signedWebhook(orgId: string, secret: string, body: unknown, tsOverride?: number) {
  const raw = JSON.stringify(body);
  const ts = String(tsOverride ?? Math.floor(Date.now() / 1000));
  const sig = createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
  return ctx.app.inject({
    method: 'POST',
    url: `/v1/webhooks/payments/${orgId}`,
    headers: { 'content-type': 'application/json', 'x-redcore-timestamp': ts, 'x-redcore-signature': `sha256=${sig}` },
    payload: raw,
  });
}

const kioskOf = async (token: string, deviceId: string) => (await call(ctx.app, 'GET', `/v1/devices/${deviceId}`, { token })).json().desiredState;

describe('EMI payment-linked lock', () => {
  it('hard-locks an overdue device with a payment screen, and a signed webhook payment unlocks it', async () => {
    const { token, orgId, deviceId, secret } = await emiDevice();
    const loan = await createLoan(token, deviceId, [{ dueDate: daysFromNow(-10), amount: 2500 }, { dueDate: daysFromNow(20), amount: 2500 }]);
    expect(loan.statusCode).toBe(201);
    expect(loan.json()).toMatchObject({ tier: 'hard_lock', overdueDays: 10, amountDue: 2500 });

    const locked = await kioskOf(token, deviceId);
    expect(locked.kiosk).toMatchObject({ mode: 'payment_due', source: 'loan_rule', supportContact: '+91 80 1234 5678', paymentUrl: 'https://pay.example.com/x' });
    expect(locked.kiosk.amountDue).toMatchObject({ amount: 2500, currency: 'INR' });
    expect(locked.notice.kind).toBe('payment_reminder');

    const accountRef = loan.json().accountRef;
    const bad = await ctx.app.inject({ method: 'POST', url: `/v1/webhooks/payments/${orgId}`, headers: { 'content-type': 'application/json', 'x-redcore-timestamp': String(Math.floor(Date.now() / 1000)), 'x-redcore-signature': 'sha256=deadbeef' }, payload: JSON.stringify({ accountRef, paymentRef: 'P1', amount: 2500 }) });
    expect(bad.statusCode).toBe(401);
    const stale = await signedWebhook(orgId, secret, { accountRef, paymentRef: 'P1', amount: 2500 }, Math.floor(Date.now() / 1000) - 3600);
    expect(stale.json().error).toBe('WEBHOOK_TIMESTAMP_INVALID');

    const paid = await signedWebhook(orgId, secret, { accountRef, paymentRef: 'P1', amount: 2500 });
    expect(paid.json()).toMatchObject({ ok: true, duplicate: false, installmentsPaid: 1, tier: 'ok' });
    const unlocked = await kioskOf(token, deviceId);
    expect(unlocked.kiosk.mode).toBe('none');
    expect(unlocked.notice).toBeNull();

    const dup = await signedWebhook(orgId, secret, { accountRef, paymentRef: 'P1', amount: 2500 });
    expect(dup.json().duplicate).toBe(true);

    const log = (await call(ctx.app, 'GET', '/v1/audit?action=loan', { token })).json().events.map((e: { action: string }) => e.action);
    expect(log).toEqual(expect.arrayContaining(['loan.create', 'loan.tier.hard_lock', 'loan.payment_received', 'loan.tier.ok']));
  });

  it('uses the nag tier past grace and a reminder notice before the due date', async () => {
    const { token, deviceId } = await emiDevice();
    await createLoan(token, deviceId, [{ dueDate: daysFromNow(-4), amount: 1000 }]);
    expect((await kioskOf(token, deviceId)).kiosk.mode).toBe('payment_nag');

    const other = await emiDevice();
    await createLoan(other.token, other.deviceId, [{ dueDate: daysFromNow(2), amount: 1000 }]);
    const st = await kioskOf(other.token, other.deviceId);
    expect(st.kiosk.mode).toBe('none');
    expect(st.notice.title).toBe('EMI payment due soon');
  });

  it('never overrides a lock placed by an admin, and respects a paused auto-lock', async () => {
    const { token, deviceId, orgId, secret } = await emiDevice();
    await call(ctx.app, 'POST', `/v1/devices/${deviceId}/lock`, { token, body: { mode: 'full', message: 'Reported stolen' } });
    const loan = await createLoan(token, deviceId, [{ dueDate: daysFromNow(-30), amount: 1000 }]);
    expect((await kioskOf(token, deviceId)).kiosk).toMatchObject({ mode: 'full', source: 'admin' });
    await signedWebhook(orgId, secret, { accountRef: loan.json().accountRef, paymentRef: 'P9', amount: 1000 });
    expect((await kioskOf(token, deviceId)).kiosk).toMatchObject({ mode: 'full', source: 'admin' });

    const b = await emiDevice();
    const l2 = await createLoan(b.token, b.deviceId, [{ dueDate: daysFromNow(-30), amount: 1000 }]);
    expect((await kioskOf(b.token, b.deviceId)).kiosk.mode).toBe('payment_due');
    await call(ctx.app, 'PATCH', `/v1/loans/${l2.json().id}`, { token: b.token, body: { autoLockPaused: true } });
    expect((await kioskOf(b.token, b.deviceId)).kiosk.mode).toBe('none');
  });

  it('the scheduler locks a device when an installment becomes overdue', async () => {
    const { token, deviceId } = await emiDevice();
    await createLoan(token, deviceId, [{ dueDate: daysFromNow(10), amount: 1000 }]);
    expect((await kioskOf(token, deviceId)).kiosk.mode).toBe('none');
    ctx.push.sent.length = 0;
    const res = await ctx.jobs.runOnce(new Date(Date.now() + 20 * 86_400_000));
    expect(res.ran).toBe(true);
    expect((await kioskOf(token, deviceId)).kiosk.mode).toBe('payment_due');
    expect(ctx.push.sent.some((p) => p.reason === 'loan_rules')).toBe(true);
  });

  it('records manual payments and closes the loan when fully paid; blocks retire while active', async () => {
    const { token, deviceId } = await emiDevice();
    const loan = await createLoan(token, deviceId, [{ dueDate: daysFromNow(-1), amount: 500 }, { dueDate: daysFromNow(29), amount: 500 }]);
    expect((await call(ctx.app, 'POST', `/v1/devices/${deviceId}/retire`, { token })).json().error).toBe('ACTIVE_LOAN');
    const pay = await call(ctx.app, 'POST', `/v1/loans/${loan.json().id}/payments`, { token, body: { paymentRef: 'CASH-1', amount: 1000 } });
    expect(pay.json()).toMatchObject({ installmentsPaid: 2, closed: true, tier: 'ok' });
    expect((await call(ctx.app, 'GET', `/v1/loans/${loan.json().id}`, { token })).json().status).toBe('closed');
  });

  it('loans are an EMI-only feature', async () => {
    const { token } = await registerOrg(ctx.app, 'govt');
    expect((await call(ctx.app, 'GET', '/v1/loans', { token })).json().error).toBe('FEATURE_NOT_AVAILABLE');
  });
});

describe('offline detection', () => {
  it('raises one tamper alert for a device that stopped checking in', async () => {
    const { token, deviceId } = await emiDevice();
    await ctx.db.query("update devices set last_seen = now() - interval '3 days' where id = $1", [deviceId]);
    await ctx.jobs.flagOfflineDevices();
    await ctx.jobs.flagOfflineDevices();
    const alerts = (await call(ctx.app, 'GET', `/v1/alerts?deviceId=${deviceId}`, { token })).json().alerts;
    expect(alerts.filter((a: { payload: { reason: string } }) => a.payload.reason === 'offline')).toHaveLength(1);
  });
});
