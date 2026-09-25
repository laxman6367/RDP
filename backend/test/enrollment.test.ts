import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, createTestApp, enrollDevice, enterpriseToken, familyToken, registerOrg, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(() => ctx.close());

describe('enrollment & consent gate', () => {
  it('refuses to create a parental enrollment for an adult', async () => {
    const { token } = await registerOrg(ctx.app, 'family');
    const res = await call(ctx.app, 'POST', '/v1/enrollment-tokens', { token, body: familyToken({ subjectAge: 25 }) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('ADULT_SUBJECT_NOT_ALLOWED');
  });

  it('requires the guardianship attestation checkbox', async () => {
    const { token } = await registerOrg(ctx.app, 'family');
    const res = await call(ctx.app, 'POST', '/v1/enrollment-tokens', { token, body: familyToken({ guardianAttestation: false }) });
    expect(res.statusCode).toBe(400);
  });

  it('refuses BYOD or Profile Owner enrollment for enterprise orgs', async () => {
    const { token } = await registerOrg(ctx.app, 'enterprise');
    const byod = await call(ctx.app, 'POST', '/v1/enrollment-tokens', { token, body: enterpriseToken({ ownership: 'byod' }) });
    expect(byod.json().error).toBe('COMPANY_OWNERSHIP_REQUIRED');
    const po = await call(ctx.app, 'POST', '/v1/enrollment-tokens', { token, body: enterpriseToken({ managementMode: 'profile_owner' }) });
    expect(po.json().error).toBe('DEVICE_OWNER_REQUIRED');
  });

  it('issues a pairing code + DO provisioning QR and shows the holder who is enrolling them', async () => {
    const { token } = await registerOrg(ctx.app, 'emi');
    const t = await call(ctx.app, 'POST', '/v1/enrollment-tokens', { token, body: enterpriseToken() });
    expect(t.statusCode).toBe(201);
    expect(t.json().code).toMatch(/^\d{6}$/);
    const qr = JSON.parse(t.json().provisioningQr);
    expect(qr['android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE']['com.redcore.agent.ENROLL_CODE']).toBe(t.json().code);
    const preview = await call(ctx.app, 'GET', `/v1/enroll/${t.json().code}`);
    expect(preview.json().attestationText).toContain('company-owned');
    expect(preview.json().managedBy).toBe('Acme Finance Ops');
  });

  it('requires holder acknowledgement and a matching DPC mode on the device', async () => {
    const { token } = await registerOrg(ctx.app, 'emi');
    const t = await call(ctx.app, 'POST', '/v1/enrollment-tokens', { token, body: enterpriseToken() });
    const base = { code: t.json().code, isProfileOwner: false, device: { manufacturer: 'X', model: 'Y', osVersion: '14', sdkInt: 34, agentVersion: '0.1.0' } };
    const noAck = await call(ctx.app, 'POST', '/v1/enroll', { body: { ...base, holderAcknowledged: false, isDeviceOwner: true } });
    expect(noAck.json().error).toBe('HOLDER_ACKNOWLEDGEMENT_REQUIRED');
    const notDo = await call(ctx.app, 'POST', '/v1/enroll', { body: { ...base, holderAcknowledged: true, isDeviceOwner: false } });
    expect(notDo.json().error).toBe('DEVICE_OWNER_REQUIRED');
  });

  it('enrolls a child device, records consent, and returns a signed state + transparency report', async () => {
    const { token } = await registerOrg(ctx.app, 'family');
    const { deviceId, credential, enroll } = await enrollDevice(ctx.app, token, familyToken({ subjectAge: 10, coppaParentalConsent: true }), { holderName: 'Riya' });
    expect(credential).toMatch(/^rcd_/);
    expect(ctx.signer.verify(enroll.state.envelope, enroll.state.signature)).toBe(true);
    expect(JSON.parse(enroll.state.envelope).deviceId).toBe(deviceId);
    expect(enroll.transparency.headline).toContain('parent/guardian: Priya Sharma');
    expect(enroll.commandPublicKey).toBe(ctx.signer.publicKeySpkiBase64());

    const detail = await call(ctx.app, 'GET', `/v1/devices/${deviceId}`, { token });
    expect(detail.json().consent.coppaApplicable).toBe(true);
    expect(detail.json().consent.deviceHolderName).toBe('Riya');
    expect(detail.json().integrity.status).toBe('unverified');

    const own = await call(ctx.app, 'GET', `/v1/devices/${deviceId}/transparency`, { token: credential });
    expect(own.statusCode).toBe(200);
    expect(own.json().managedBy).toBe('Priya Sharma');
  });

  it('is single-use', async () => {
    const { token } = await registerOrg(ctx.app, 'govt');
    const t = await call(ctx.app, 'POST', '/v1/enrollment-tokens', { token, body: enterpriseToken() });
    const body = { code: t.json().code, holderAcknowledged: true, isDeviceOwner: true, isProfileOwner: false, device: { manufacturer: 'X', model: 'Y', osVersion: '14', sdkInt: 34, agentVersion: '0.1.0' } };
    expect((await call(ctx.app, 'POST', '/v1/enroll', { body })).statusCode).toBe(201);
    expect((await call(ctx.app, 'POST', '/v1/enroll', { body })).statusCode).toBe(404);
  });
});
