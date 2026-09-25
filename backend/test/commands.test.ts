import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, createTestApp, enrollDevice, enterpriseToken, familyToken, heartbeat, registerOrg, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(() => ctx.close());

describe('command queue & reconciliation', () => {
  it('lock → push wake → pull signed command → ack → in sync', async () => {
    const { token } = await registerOrg(ctx.app, 'govt');
    const { deviceId, credential } = await enrollDevice(ctx.app, token, enterpriseToken());
    ctx.push.sent.length = 0;

    const lock = await call(ctx.app, 'POST', `/v1/devices/${deviceId}/lock`, { token, body: { mode: 'kiosk', allowlist: ['gov.field.app'] } });
    expect(lock.statusCode).toBe(200);
    expect(lock.json()).toMatchObject({ changed: true, desiredVersion: 2 });
    expect(ctx.push.sent).toEqual([{ token: 'fcm-test-token', reason: 'device.lock' }]);

    const hb = await heartbeat(ctx.app, deviceId, credential, 1);
    expect(hb.json().pendingCommands).toBe(1);
    expect(hb.json().state).not.toBeNull();

    const pulled = await call(ctx.app, 'GET', `/v1/devices/${deviceId}/commands`, { token: credential });
    const [cmd] = pulled.json().commands;
    expect(ctx.signer.verify(cmd.envelope, cmd.signature)).toBe(true);
    const env = JSON.parse(cmd.envelope);
    expect(env).toMatchObject({ kind: 'command', type: 'APPLY_STATE', deviceId });
    expect(env.payload.state.kiosk).toMatchObject({ mode: 'single_purpose', allowlist: ['gov.field.app'], source: 'admin' });

    // Not redelivered until the backoff elapses.
    expect((await call(ctx.app, 'GET', `/v1/devices/${deviceId}/commands`, { token: credential })).json().commands).toHaveLength(0);

    const ack = await call(ctx.app, 'POST', `/v1/devices/${deviceId}/commands/${cmd.id}/ack`, { token: credential, body: { status: 'succeeded' } });
    expect(ack.json().status).toBe('succeeded');
    // Idempotent ack.
    expect((await call(ctx.app, 'POST', `/v1/devices/${deviceId}/commands/${cmd.id}/ack`, { token: credential, body: { status: 'failed' } })).json().status).toBe('succeeded');

    const hb2 = await heartbeat(ctx.app, deviceId, credential, 2);
    expect(hb2.json().state).toBeNull();
    const detail = await call(ctx.app, 'GET', `/v1/devices/${deviceId}`, { token });
    expect(detail.json().device.inSync).toBe(true);
    expect(detail.json().device.kioskMode).toBe('single_purpose');

    const history = await call(ctx.app, 'GET', `/v1/devices/${deviceId}/command-history`, { token });
    expect(history.json().commands[0]).toMatchObject({ type: 'APPLY_STATE', status: 'succeeded' });
    expect(history.json().commands[0].issuedBy).toBeTruthy();
  });

  it('is idempotent for repeated requests and Idempotency-Key retries', async () => {
    const { token } = await registerOrg(ctx.app, 'enterprise');
    const { deviceId } = await enrollDevice(ctx.app, token, enterpriseToken());
    const body = { mode: 'full' };
    const h = { 'idempotency-key': 'req-123' };
    const a = await call(ctx.app, 'POST', `/v1/devices/${deviceId}/lock`, { token, body, headers: h });
    const b = await call(ctx.app, 'POST', `/v1/devices/${deviceId}/lock`, { token, body, headers: h });
    expect(b.json().commandId).toBe(a.json().commandId);
    const c = await call(ctx.app, 'POST', `/v1/devices/${deviceId}/lock`, { token, body });
    expect(c.json().changed).toBe(false);
    const un = await call(ctx.app, 'POST', `/v1/devices/${deviceId}/unlock`, { token });
    expect(un.json()).toMatchObject({ changed: true, desiredVersion: 3 });
    // The superseded lock command is cancelled so the device only gets the newest state.
    const { rows } = await ctx.db.query('select status from commands where device_id = $1 order by created_at', [deviceId]);
    expect(rows.map((r) => r.status)).toEqual(['cancelled', 'pending']);
  });

  it('a device that missed commands converges from the heartbeat state', async () => {
    const { token } = await registerOrg(ctx.app, 'enterprise');
    const { deviceId, credential } = await enrollDevice(ctx.app, token, enterpriseToken());
    await call(ctx.app, 'POST', `/v1/devices/${deviceId}/lock`, { token, body: { mode: 'full' } });
    await ctx.db.query("update commands set status = 'expired' where device_id = $1", [deviceId]);
    const hb = await heartbeat(ctx.app, deviceId, credential, 1);
    const env = JSON.parse(hb.json().state.envelope);
    expect(ctx.signer.verify(hb.json().state.envelope, hb.json().state.signature)).toBe(true);
    expect(env).toMatchObject({ kind: 'state', version: 2 });
    expect(env.state.kiosk.mode).toBe('full');
  });

  it('rejects another device\'s credential', async () => {
    const { token } = await registerOrg(ctx.app, 'govt');
    const a = await enrollDevice(ctx.app, token, enterpriseToken());
    const b = await enrollDevice(ctx.app, token, enterpriseToken());
    expect((await call(ctx.app, 'GET', `/v1/devices/${a.deviceId}/commands`, { token: b.credential })).statusCode).toBe(401);
  });

  it('flags clock manipulation and a disabled admin as tamper alerts', async () => {
    const { token } = await registerOrg(ctx.app, 'govt');
    const { deviceId, credential } = await enrollDevice(ctx.app, token, enterpriseToken());
    await heartbeat(ctx.app, deviceId, credential, 1, {
      clientTime: new Date(Date.now() - 3_600_000).toISOString(),
      reportedState: { isDeviceOwner: true, adminActive: false },
    });
    const alerts = await call(ctx.app, 'GET', `/v1/alerts?deviceId=${deviceId}`, { token });
    expect(alerts.json().alerts.map((a: { payload: { reason: string } }) => a.payload.reason).sort()).toEqual(['admin_disabled', 'clock_skew']);
  });

  it('retire: the agent acks the released state and its credential stops working', async () => {
    const { token } = await registerOrg(ctx.app, 'enterprise');
    const { deviceId, credential } = await enrollDevice(ctx.app, token, enterpriseToken());
    await call(ctx.app, 'POST', `/v1/devices/${deviceId}/retire`, { token });
    const [cmd] = (await call(ctx.app, 'GET', `/v1/devices/${deviceId}/commands`, { token: credential })).json().commands;
    const state = JSON.parse(cmd.envelope).payload.state;
    expect(state.released).toBe(true);
    expect(state.userRestrictions).toEqual([]);
    await call(ctx.app, 'POST', `/v1/devices/${deviceId}/commands/${cmd.id}/ack`, { token: credential, body: { status: 'succeeded' } });
    expect((await heartbeat(ctx.app, deviceId, credential, 2)).statusCode).toBe(401);
  });
});

describe('segment gating, RBAC and isolation', () => {
  it('Phase 2 orgs cannot locate, read apps or send telemetry', async () => {
    const { token } = await registerOrg(ctx.app, 'emi');
    const { deviceId, credential } = await enrollDevice(ctx.app, token, enterpriseToken());
    expect((await call(ctx.app, 'POST', `/v1/devices/${deviceId}/locate`, { token })).json().error).toBe('FEATURE_NOT_AVAILABLE');
    expect((await call(ctx.app, 'GET', `/v1/devices/${deviceId}/apps`, { token })).statusCode).toBe(403);
    const t = await call(ctx.app, 'POST', `/v1/devices/${deviceId}/telemetry`, {
      token: credential,
      body: { items: [{ kind: 'location', ts: new Date().toISOString(), payload: { lat: 1, lng: 2 } }] },
    });
    expect(t.json()).toMatchObject({ accepted: 0, rejected: [{ reason: 'NOT_ENABLED_BY_POLICY' }] });
  });

  it('parental orgs cannot issue a payment lock', async () => {
    const { token } = await registerOrg(ctx.app, 'family');
    const { deviceId } = await enrollDevice(ctx.app, token, familyToken());
    const res = await call(ctx.app, 'POST', `/v1/devices/${deviceId}/lock`, { token, body: { mode: 'payment', supportContact: 'x' } });
    expect(res.json().error).toBe('LOCK_MODE_NOT_AVAILABLE');
  });

  it('enforces roles', async () => {
    const { token } = await registerOrg(ctx.app, 'govt');
    const { deviceId } = await enrollDevice(ctx.app, token, enterpriseToken());
    for (const role of ['read_only', 'operator'] as const) {
      const email = `${role}-${Date.now()}@example.com`;
      await call(ctx.app, 'POST', '/v1/admins', { token, body: { email, displayName: role, role, temporaryPassword: 'temporary-pass-1' } });
      const login = await call(ctx.app, 'POST', '/v1/auth/login', { body: { email, password: 'temporary-pass-1' } });
      const t = login.json().accessToken;
      const lock = await call(ctx.app, 'POST', `/v1/devices/${deviceId}/lock`, { token: t, body: { mode: 'full' } });
      const policy = await call(ctx.app, 'POST', '/v1/policies', { token: t, body: { name: 'x', spec: {} } });
      expect(policy.statusCode).toBe(403);
      expect(lock.statusCode).toBe(role === 'operator' ? 200 : 403);
      if (role === 'operator') await call(ctx.app, 'POST', `/v1/devices/${deviceId}/unlock`, { token: t });
    }
  });

  it('hides other organizations\' devices', async () => {
    const a = await registerOrg(ctx.app, 'govt');
    const b = await registerOrg(ctx.app, 'govt');
    const { deviceId } = await enrollDevice(ctx.app, a.token, enterpriseToken());
    expect((await call(ctx.app, 'GET', `/v1/devices/${deviceId}`, { token: b.token })).statusCode).toBe(404);
    expect((await call(ctx.app, 'POST', `/v1/devices/${deviceId}/lock`, { token: b.token, body: { mode: 'full' } })).statusCode).toBe(404);
    expect((await call(ctx.app, 'GET', '/v1/devices', { token: b.token })).json().devices).toHaveLength(0);
  });

  it('audits every admin action and exports CSV', async () => {
    const { token, orgId } = await registerOrg(ctx.app, 'govt');
    const { deviceId } = await enrollDevice(ctx.app, token, enterpriseToken());
    await call(ctx.app, 'POST', `/v1/devices/${deviceId}/lock`, { token, body: { mode: 'full' } });
    const log = await call(ctx.app, 'GET', '/v1/audit', { token });
    const actions = log.json().events.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['org.register', 'enrollment.token_created', 'device.enrolled', 'device.lock']));
    expect(log.json().events.find((e: { action: string }) => e.action === 'device.lock').actorEmail).toContain('@example.com');
    const csv = await call(ctx.app, 'GET', '/v1/audit?format=csv', { token });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\n')[0]).toBe('id,ts,actor_type,actor_id,actor_email,action,target_type,target_id,ip,meta');
    const { rows } = await ctx.db.query("select count(*)::int as n from audit_events where org_id = $1 and action = 'audit.exported'", [orgId]);
    expect(rows[0].n).toBe(1);
  });
});
