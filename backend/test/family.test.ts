import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, createTestApp, enrollDevice, familyToken, registerOrg, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(() => ctx.close());

const now = () => new Date().toISOString();

async function familyWithPolicy(spec: unknown) {
  const { token } = await registerOrg(ctx.app, 'family');
  const policy = await call(ctx.app, 'POST', '/v1/policies', { token, body: { name: 'School days', spec } });
  expect(policy.statusCode).toBe(201);
  const dev = await enrollDevice(ctx.app, token, familyToken({ policyId: policy.json().id }));
  return { token, policyId: policy.json().id as string, ...dev };
}

describe('Phase 1 parental control', () => {
  it('delivers the policy at enrollment and re-applies edits to assigned devices', async () => {
    const { token, policyId, deviceId, enroll } = await familyWithPolicy({ apps: { blocked: ['com.game.one'], requireInstallApproval: true } });
    const st = JSON.parse(enroll.state.envelope).state;
    expect(st.policy.spec.apps.blocked).toEqual(['com.game.one']);
    expect(st.userRestrictions).toEqual(['no_install_apps']);
    expect(enroll.transparency.items.map((i: { key: string }) => i.key)).toContain('apps.install');

    const upd = await call(ctx.app, 'PUT', `/v1/policies/${policyId}`, { token, body: { spec: { apps: { blocked: ['com.game.two'] } } } });
    expect(upd.json()).toMatchObject({ version: 2, devicesUpdated: 1 });
    const detail = await call(ctx.app, 'GET', `/v1/devices/${deviceId}`, { token });
    expect(detail.json().desiredState.policy).toMatchObject({ version: 2, spec: { apps: { blocked: ['com.game.two'] } } });
    expect(detail.json().desiredState.userRestrictions).toEqual([]);
  });

  it('rejects invalid policy specs with field errors', async () => {
    const { token } = await registerOrg(ctx.app, 'family');
    const res = await call(ctx.app, 'POST', '/v1/policies', { token, body: { name: 'bad', spec: { location: { intervalMinutes: 1 }, spy: true } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.length).toBeGreaterThan(0);
  });

  it('accepts only the telemetry the policy enables and strips SMS bodies in metadata mode', async () => {
    const { token, deviceId, credential } = await familyWithPolicy({ location: { enabled: true }, comms: { sms: 'metadata' } });
    const res = await call(ctx.app, 'POST', `/v1/devices/${deviceId}/telemetry`, {
      token: credential,
      body: {
        items: [
          { kind: 'location', ts: now(), payload: { lat: 19.07, lng: 72.87, accuracy: 12 } },
          { kind: 'sms', ts: now(), payload: { address: '+919999999999', direction: 'in', body: 'secret' } },
          { kind: 'call_log', ts: now(), payload: { number: '+911', durationSec: 5 } },
          { kind: 'app_inventory', ts: now(), payload: { apps: [{ package: 'com.game.one', label: 'Game' }] } },
          { kind: 'app_usage', ts: now(), payload: { day: '2026-09-25', usage: [{ package: 'com.game.one', minutes: 42, lastUsed: now() }] } },
        ],
      },
    });
    expect(res.json().accepted).toBe(4);
    expect(res.json().rejected).toEqual([{ index: 2, kind: 'call_log', reason: 'NOT_ENABLED_BY_POLICY' }]);

    const sms = await call(ctx.app, 'GET', `/v1/devices/${deviceId}/telemetry/sms`, { token });
    expect(sms.json().items[0].payload).toEqual({ address: '+919999999999', direction: 'in' });

    const apps = await call(ctx.app, 'GET', `/v1/devices/${deviceId}/apps`, { token });
    expect(apps.json().apps[0]).toMatchObject({ package: 'com.game.one', blocked: false });
    expect(apps.json().usage[0]).toMatchObject({ package: 'com.game.one', minutes: 42 });

    const locs = await call(ctx.app, 'GET', `/v1/devices/${deviceId}/locations`, { token });
    expect(locs.json().locations[0]).toMatchObject({ lat: 19.07, lng: 72.87 });
  });

  it('on-demand locate needs location enabled; the result lands in the history', async () => {
    const off = await familyWithPolicy({});
    expect((await call(ctx.app, 'POST', `/v1/devices/${off.deviceId}/locate`, { token: off.token })).json().error).toBe('LOCATION_NOT_ENABLED');

    const { token, deviceId, credential } = await familyWithPolicy({ location: { enabled: true } });
    const loc = await call(ctx.app, 'POST', `/v1/devices/${deviceId}/locate`, { token });
    expect(loc.statusCode).toBe(200);
    const cmds = (await call(ctx.app, 'GET', `/v1/devices/${deviceId}/commands`, { token: credential })).json().commands;
    const locate = cmds.find((c: { type: string }) => c.type === 'LOCATE');
    await call(ctx.app, 'POST', `/v1/devices/${deviceId}/commands/${locate.id}/ack`, {
      token: credential,
      body: { status: 'succeeded', result: { location: { lat: 12.9, lng: 77.6, accuracy: 8 } } },
    });
    const locs = await call(ctx.app, 'GET', `/v1/devices/${deviceId}/locations`, { token });
    expect(locs.json().locations[0]).toMatchObject({ lat: 12.9, source: 'locate' });
  });

  it('gates alerts by policy (geofence off → refused; SOS on by default)', async () => {
    const { token, deviceId, credential } = await familyWithPolicy({});
    expect((await call(ctx.app, 'POST', `/v1/devices/${deviceId}/alerts`, { token: credential, body: { kind: 'geofence_enter', payload: { fence: 'school' } } })).statusCode).toBe(403);
    expect((await call(ctx.app, 'POST', `/v1/devices/${deviceId}/alerts`, { token: credential, body: { kind: 'sos', payload: { lat: 1, lng: 2 } } })).statusCode).toBe(201);
    const alerts = await call(ctx.app, 'GET', '/v1/alerts?unacknowledged=true', { token });
    expect(alerts.json().alerts).toHaveLength(1);
    const id = alerts.json().alerts[0].id;
    expect((await call(ctx.app, 'POST', `/v1/alerts/${id}/ack`, { token })).statusCode).toBe(200);
    expect((await call(ctx.app, 'GET', '/v1/alerts?unacknowledged=true', { token })).json().alerts).toHaveLength(0);
  });

  it('lost-device snapshot is disclosed, uploaded only for an open command, and audited when viewed', async () => {
    const { token, deviceId, credential } = await familyWithPolicy({ antiTheft: { enabled: true } });
    const lost = await call(ctx.app, 'POST', `/v1/devices/${deviceId}/lost`, { token, body: {} });
    const cid = lost.json().commandId;
    const cmd = (await call(ctx.app, 'GET', `/v1/devices/${deviceId}/commands`, { token: credential })).json().commands[0];
    expect(JSON.parse(cmd.envelope).payload.visibleNotice).toBe(true);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const up = await ctx.app.inject({ method: 'POST', url: `/v1/devices/${deviceId}/commands/${cid}/attachment`, headers: { authorization: `Bearer ${credential}`, 'content-type': 'image/jpeg' }, payload: jpeg });
    expect(up.statusCode).toBe(200);
    await call(ctx.app, 'POST', `/v1/devices/${deviceId}/commands/${cid}/ack`, { token: credential, body: { status: 'succeeded' } });
    const again = await ctx.app.inject({ method: 'POST', url: `/v1/devices/${deviceId}/commands/${cid}/attachment`, headers: { authorization: `Bearer ${credential}`, 'content-type': 'image/jpeg' }, payload: jpeg });
    expect(again.statusCode).toBe(404);
    const view = await call(ctx.app, 'GET', `/v1/devices/${deviceId}/commands/${cid}/attachment`, { token });
    expect(view.rawPayload.equals(jpeg)).toBe(true);
    const audit = await call(ctx.app, 'GET', `/v1/devices/${deviceId}/audit`, { token });
    expect(audit.json().events.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(['command.anti_theft_snapshot', 'command.attachment_viewed']));
  });

  it('exports and deletes subject data; retention purges expired telemetry', async () => {
    const { token, deviceId, credential } = await familyWithPolicy({ location: { enabled: true } });
    await call(ctx.app, 'POST', `/v1/devices/${deviceId}/telemetry`, { token: credential, body: { items: [{ kind: 'location', ts: now(), payload: { lat: 1, lng: 2 } }] } });
    const exp = await call(ctx.app, 'GET', `/v1/devices/${deviceId}/export`, { token });
    expect(exp.json().telemetry).toHaveLength(1);
    expect(exp.json().device).not.toHaveProperty('credential_hash');
    expect(exp.json().consents[0].type).toBe('guardian_of_minor');

    await ctx.db.query("update telemetry set expires_at = now() - interval '1 minute' where device_id = $1", [deviceId]);
    expect(await ctx.jobs.purgeTelemetry()).toBe(1);

    await call(ctx.app, 'POST', `/v1/devices/${deviceId}/telemetry`, { token: credential, body: { items: [{ kind: 'location', ts: now(), payload: { lat: 1, lng: 2 } }] } });
    const del = await call(ctx.app, 'DELETE', `/v1/devices/${deviceId}/telemetry`, { token });
    expect(del.json().deleted.telemetry).toBe(1);
  });

  it('study mode lock works on Profile Owner devices; kiosk needs Device Owner', async () => {
    const { token } = await registerOrg(ctx.app, 'family');
    const { deviceId } = await enrollDevice(ctx.app, token, familyToken({ managementMode: 'profile_owner', ownership: 'byod' }));
    expect((await call(ctx.app, 'POST', `/v1/devices/${deviceId}/lock`, { token, body: { mode: 'kiosk', allowlist: ['org.khanacademy.android'] } })).json().error).toBe('DEVICE_OWNER_REQUIRED');
    expect((await call(ctx.app, 'POST', `/v1/devices/${deviceId}/lock`, { token, body: { mode: 'study', allowlist: ['org.khanacademy.android'] } })).statusCode).toBe(200);
  });
});
