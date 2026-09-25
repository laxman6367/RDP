import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, createTestApp, enrollDevice, enterpriseToken, familyToken, registerOrg, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(() => ctx.close());

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body')]);

function upload(token: string, data: Buffer, name = 'brand.png') {
  const boundary = '----redcore';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nBranding\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: image/png\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return ctx.app.inject({ method: 'POST', url: '/v1/wallpapers', headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
}

describe('wallpaper change (Phase 2)', () => {
  it('uploads, pushes to a device, locks it, and the device downloads the exact bytes', async () => {
    const { token } = await registerOrg(ctx.app, 'enterprise');
    const { deviceId, credential } = await enrollDevice(ctx.app, token, enterpriseToken());
    const up = await upload(token, PNG);
    expect(up.statusCode).toBe(201);
    expect(up.json()).toMatchObject({ name: 'Branding', contentType: 'image/png', sha256: createHash('sha256').update(PNG).digest('hex') });

    const set = await call(ctx.app, 'POST', `/v1/devices/${deviceId}/wallpaper`, { token, body: { wallpaperId: up.json().id, lockChange: true } });
    expect(set.json().changed).toBe(true);
    const [cmd] = (await call(ctx.app, 'GET', `/v1/devices/${deviceId}/commands`, { token: credential })).json().commands;
    const state = JSON.parse(cmd.envelope).payload.state;
    expect(state.wallpaper).toMatchObject({ wallpaperId: up.json().id, lockChange: true, source: 'admin' });
    expect(state.userRestrictions).toContain('no_set_wallpaper');

    const dl = await ctx.app.inject({ method: 'GET', url: state.wallpaper.path, headers: { authorization: `Bearer ${credential}` } });
    expect(dl.rawPayload.equals(PNG)).toBe(true);
    expect(dl.headers['x-content-sha256']).toBe(up.json().sha256);
  });

  it('rejects non-images and is unavailable to parental orgs', async () => {
    const { token } = await registerOrg(ctx.app, 'govt');
    expect((await upload(token, Buffer.from('<svg/>'))).json().error).toBe('UNSUPPORTED_IMAGE');
    const fam = await registerOrg(ctx.app, 'family');
    const { deviceId } = await enrollDevice(ctx.app, fam.token, familyToken());
    expect((await call(ctx.app, 'POST', `/v1/devices/${deviceId}/wallpaper`, { token: fam.token, body: { wallpaperId: null } })).statusCode).toBe(403);
  });

  it('applies a fleet default wallpaper from the policy, without overriding a device-specific one', async () => {
    const { token } = await registerOrg(ctx.app, 'govt');
    const a = await enrollDevice(ctx.app, token, enterpriseToken());
    const b = await enrollDevice(ctx.app, token, enterpriseToken());
    const fleet = (await upload(token, PNG, 'fleet.png')).json().id;
    const special = (await upload(token, Buffer.concat([PNG, Buffer.from('x')]), 'special.png')).json().id;
    await call(ctx.app, 'POST', `/v1/devices/${b.deviceId}/wallpaper`, { token, body: { wallpaperId: special } });

    const policy = await call(ctx.app, 'POST', '/v1/policies', { token, body: { name: 'Dept', spec: { wallpaper: { defaultWallpaperId: fleet, lockChange: true }, kiosk: { enforced: true, allowlist: ['gov.inspect'] } } } });
    expect(policy.statusCode).toBe(201);
    const assign = await call(ctx.app, 'POST', `/v1/policies/${policy.json().id}/assign`, { token, body: { deviceIds: [a.deviceId, b.deviceId] } });
    expect(assign.json().devicesUpdated).toBe(2);

    const stA = (await call(ctx.app, 'GET', `/v1/devices/${a.deviceId}`, { token })).json().desiredState;
    const stB = (await call(ctx.app, 'GET', `/v1/devices/${b.deviceId}`, { token })).json().desiredState;
    expect(stA.wallpaper).toMatchObject({ wallpaperId: fleet, source: 'policy' });
    expect(stB.wallpaper).toMatchObject({ wallpaperId: special, source: 'admin' });
    expect(stA.policy.spec.kiosk).toMatchObject({ enforced: true, allowlist: ['gov.inspect'] });

    // Clearing the device-specific wallpaper falls back to the fleet default.
    await call(ctx.app, 'POST', `/v1/devices/${b.deviceId}/wallpaper`, { token, body: { wallpaperId: null } });
    expect((await call(ctx.app, 'GET', `/v1/devices/${b.deviceId}`, { token })).json().desiredState.wallpaper).toMatchObject({ wallpaperId: fleet, source: 'policy' });
  });
});
