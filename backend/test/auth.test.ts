import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt } from '../src/security/totp.js';
import { call, createTestApp, registerOrg, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await createTestApp({ REQUIRE_MFA: true });
});
afterAll(() => ctx.close());

describe('admin auth with mandatory MFA', () => {
  it('blocks data access until MFA is enrolled, then requires the code at login', async () => {
    const { token, email } = await registerOrg(ctx.app, 'family');
    const blocked = await call(ctx.app, 'GET', '/v1/devices', { token });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe('MFA_REQUIRED');

    const setup = await call(ctx.app, 'POST', '/v1/auth/mfa/setup', { token });
    expect(setup.statusCode).toBe(200);
    const { secret, otpauthUri } = setup.json();
    expect(otpauthUri).toContain('otpauth://totp/');

    expect((await call(ctx.app, 'POST', '/v1/auth/mfa/enable', { token, body: { code: '000000' } })).statusCode).toBe(401);
    const enabled = await call(ctx.app, 'POST', '/v1/auth/mfa/enable', { token, body: { code: totpAt(secret, Date.now()) } });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().mfa).toBe(true);
    expect((await call(ctx.app, 'GET', '/v1/devices', { token: enabled.json().accessToken })).statusCode).toBe(200);

    const noCode = await call(ctx.app, 'POST', '/v1/auth/login', { body: { email, password: 'correct-horse-battery' } });
    expect(noCode.json().error).toBe('MFA_CODE_REQUIRED');
    const ok = await call(ctx.app, 'POST', '/v1/auth/login', { body: { email, password: 'correct-horse-battery', totp: totpAt(secret, Date.now()) } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().mfa).toBe(true);
  });

  it('rejects bad passwords and audits the failure', async () => {
    const { email, orgId } = await registerOrg(ctx.app, 'emi');
    const res = await call(ctx.app, 'POST', '/v1/auth/login', { body: { email, password: 'nope-nope-nope' } });
    expect(res.statusCode).toBe(401);
    const { rows } = await ctx.db.query("select 1 from audit_events where org_id = $1 and action = 'auth.login_failed'", [orgId]);
    expect(rows.length).toBe(1);
  });

  it('rotates refresh tokens and refuses reuse or MFA upgrade', async () => {
    const { refreshToken } = await registerOrg(ctx.app, 'govt');
    const first = await call(ctx.app, 'POST', '/v1/auth/refresh', { body: { refreshToken } });
    expect(first.statusCode).toBe(200);
    expect((await call(ctx.app, 'POST', '/v1/auth/refresh', { body: { refreshToken } })).statusCode).toBe(401);
    const forged = first.json().refreshToken.replace(/\.0$/, '.1');
    expect((await call(ctx.app, 'POST', '/v1/auth/refresh', { body: { refreshToken: forged } })).statusCode).toBe(401);
  });
});
