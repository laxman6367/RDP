import { describe, expect, it } from 'vitest';
import { initialDesiredState, withDerived } from '../src/domain/desired-state.js';
import { assertEnrollmentAllowed } from '../src/domain/enrollment-rules.js';
import { evaluateLoan } from '../src/domain/loan-rules.js';
import { enterprisePolicySchema, familyPolicySchema } from '../src/domain/policy.js';
import { hasCapability, lockModeAllowed } from '../src/domain/segments.js';
import { alertAllowed, minimizePayload, telemetryAllowed } from '../src/domain/telemetry-rules.js';
import { buildTransparencyReport } from '../src/domain/transparency.js';
import { CommandSigner } from '../src/security/command-signer.js';
import { hashPassword, verifyPassword } from '../src/security/passwords.js';
import { base32Decode, base32Encode, totpAt, verifyTotp } from '../src/security/totp.js';

describe('TOTP', () => {
  it('matches the RFC 6238 SHA-1 test vectors', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(totpAt(secret, 59_000, 30, 8)).toBe('94287082');
    expect(totpAt(secret, 1_111_111_109_000, 30, 8)).toBe('07081804');
    expect(totpAt(secret, 20_000_000_000_000, 30, 8)).toBe('65353130');
  });

  it('accepts one step of drift and rejects garbage', () => {
    const secret = base32Encode(Buffer.from('abcdefghijabcdefghij'));
    const now = 1_700_000_000_000;
    expect(verifyTotp(secret, totpAt(secret, now - 30_000), now)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, now - 90_000), now)).toBe(false);
    expect(verifyTotp(secret, 'abcdef', now)).toBe(false);
  });

  it('round-trips base32', () => {
    const buf = Buffer.from([0, 1, 2, 250, 251, 252, 253]);
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
  });
});

describe('passwords', () => {
  it('hashes and verifies with scrypt', async () => {
    const h = await hashPassword('correct horse');
    expect(await verifyPassword('correct horse', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });
});

describe('CommandSigner', () => {
  it('signs envelopes that verify with the exported SPKI key and rejects tampering', async () => {
    const signer = CommandSigner.generate();
    const env = JSON.stringify({ id: 'x', type: 'APPLY_STATE' });
    const sig = signer.sign(env);
    expect(signer.verify(env, sig)).toBe(true);
    expect(signer.verify(env.replace('x', 'y'), sig)).toBe(false);
    const { createPublicKey, verify } = await import('node:crypto');
    const pub = createPublicKey({ key: Buffer.from(signer.publicKeySpkiBase64(), 'base64'), format: 'der', type: 'spki' });
    expect(verify('sha256', Buffer.from(env), pub, Buffer.from(sig, 'base64'))).toBe(true);
    expect(CommandSigner.fromPem(signer.privateKeyPem()).verify(env, sig)).toBe(true);
  });
});

describe('loan rules', () => {
  const terms = { reminderDays: 3, graceDays: 2, hardLockAfterDays: 7 };
  const inst = (dueDate: string, paid = false) => ({ dueDate, amount: 1000, paidAt: paid ? '2026-01-01T00:00:00Z' : null });

  it.each([
    ['2026-03-01', 'ok', 0],
    ['2026-03-07', 'reminder', 0], // 3 days before due
    ['2026-03-10', 'reminder', 0], // due today
    ['2026-03-12', 'reminder', 2], // within grace
    ['2026-03-13', 'nag', 3],
    ['2026-03-16', 'nag', 6],
    ['2026-03-17', 'hard_lock', 7],
  ])('on %s the tier is %s', (today, tier, overdue) => {
    const ev = evaluateLoan([inst('2026-03-10'), inst('2026-04-10')], terms, today);
    expect(ev.tier).toBe(tier);
    expect(ev.overdueDays).toBe(overdue);
  });

  it('sums every installment already due and is ok when all are paid', () => {
    const ev = evaluateLoan([inst('2026-01-10'), inst('2026-02-10'), inst('2026-03-10')], terms, '2026-02-20');
    expect(ev.amountDue).toBe(2000);
    expect(ev.tier).toBe('hard_lock');
    expect(evaluateLoan([inst('2026-01-10', true)], terms, '2026-06-01').tier).toBe('ok');
  });
});

describe('enrollment anti-abuse rules', () => {
  const fam = { managementMode: 'device_owner' as const, ownership: 'company' as const, consentType: 'guardian_of_minor' as const, guardianAttestation: true };

  it('refuses adult subjects on parental plans', () => {
    expect(() => assertEnrollmentAllowed('family', { ...fam, subjectAge: 18 })).toThrow(/minor/);
    expect(() => assertEnrollmentAllowed('family', { ...fam, subjectAge: 30 })).toThrow();
  });

  it('requires COPPA consent under 13', () => {
    expect(() => assertEnrollmentAllowed('family', { ...fam, subjectAge: 9 })).toThrow(/under 13/);
    expect(assertEnrollmentAllowed('family', { ...fam, subjectAge: 9, coppaParentalConsent: true }).coppaApplicable).toBe(true);
    expect(assertEnrollmentAllowed('family', { ...fam, subjectAge: 15 }).coppaApplicable).toBe(false);
  });

  it('requires company-owned Device Owner for enterprise', () => {
    const ent = { managementMode: 'device_owner' as const, ownership: 'company' as const, consentType: 'company_owned' as const, guardianAttestation: true };
    expect(() => assertEnrollmentAllowed('emi', ent)).not.toThrow();
    expect(() => assertEnrollmentAllowed('emi', { ...ent, ownership: 'byod' })).toThrow(/company-owned/);
    expect(() => assertEnrollmentAllowed('govt', { ...ent, managementMode: 'profile_owner' })).toThrow(/Device Owner/);
    expect(() => assertEnrollmentAllowed('enterprise', { ...ent, consentType: 'guardian_of_minor' })).toThrow();
  });
});

describe('segments & policy schemas', () => {
  it('limits Phase 2 to kiosk + wallpaper', () => {
    for (const t of ['emi', 'govt', 'enterprise'] as const) {
      expect(hasCapability(t, 'kiosk')).toBe(true);
      expect(hasCapability(t, 'wallpaper')).toBe(true);
      for (const c of ['location', 'comms', 'social', 'apps', 'camera'] as const) expect(hasCapability(t, c)).toBe(false);
    }
    expect(lockModeAllowed('family', 'payment')).toBe(false);
    expect(lockModeAllowed('emi', 'payment')).toBe(true);
  });

  it('rejects monitoring keys in an enterprise policy', () => {
    expect(enterprisePolicySchema.safeParse({ location: { enabled: true } }).success).toBe(false);
    expect(enterprisePolicySchema.safeParse({ kiosk: { enforced: true, allowlist: ['com.acme.pos'] } }).success).toBe(true);
  });

  it('defaults every family collection flag to off', () => {
    const p = familyPolicySchema.parse({});
    expect(p.location.enabled).toBe(false);
    expect(p.comms.sms).toBe('off');
    expect(p.social.notificationSafetySignals).toBe(false);
    expect(familyPolicySchema.safeParse({ apps: { blocked: ['not a package'] } }).success).toBe(false);
  });

  it('derives anti-tamper restrictions for Phase 2 and wallpaper lock', () => {
    const s = initialDesiredState('emi');
    expect(s.userRestrictions).toEqual(['no_add_user', 'no_factory_reset', 'no_safe_boot', 'no_uninstall_apps_redcore']);
    const withWp = withDerived({ ...s, wallpaper: { wallpaperId: 'w', path: '/x', sha256: 'h', target: 'both', lockChange: true, source: 'admin' } });
    expect(withWp.userRestrictions).toContain('no_set_wallpaper');
    expect(withDerived({ ...s, released: true }).userRestrictions).toEqual([]);
    expect(initialDesiredState('family').userRestrictions).toEqual([]);
  });
});

describe('data minimization', () => {
  const fam = (spec: unknown) => ({ ...initialDesiredState('family'), policy: { id: 'p', version: 1, spec: familyPolicySchema.parse(spec) } });

  it('only accepts telemetry the policy enabled', () => {
    expect(telemetryAllowed(fam({}), 'location')).toBe(false);
    expect(telemetryAllowed(fam({ location: { enabled: true } }), 'location')).toBe(true);
    expect(telemetryAllowed(fam({}), 'sms')).toBe(false);
    expect(telemetryAllowed(initialDesiredState('emi'), 'app_usage')).toBe(false);
    expect(alertAllowed(initialDesiredState('emi'), 'tamper')).toBe(true);
    expect(alertAllowed(initialDesiredState('emi'), 'sos')).toBe(false);
  });

  it('strips SMS bodies unless content visibility is on', () => {
    const payload = { from: '+911234567890', body: 'hello', ts: 'x' };
    expect(minimizePayload(fam({ comms: { sms: 'metadata' } }), 'sms', payload)).not.toHaveProperty('body');
    expect(minimizePayload(fam({ comms: { sms: 'content' } }), 'sms', payload)).toHaveProperty('body', 'hello');
  });
});

describe('transparency report', () => {
  it('lists exactly what the family policy enables', () => {
    const state = { ...initialDesiredState('family'), policy: { id: 'p', version: 1, spec: familyPolicySchema.parse({ location: { enabled: true, intervalMinutes: 30 }, comms: { sms: 'metadata' } }) } };
    const r = buildTransparencyReport({ orgType: 'family', orgName: 'Sharma family', managedBy: 'Priya', state });
    expect(r.headline).toContain('parent/guardian: Priya');
    const keys = r.items.map((i) => i.key);
    expect(keys).toContain('location');
    expect(keys).toContain('comms.sms');
    expect(keys).not.toContain('comms.calls');
    expect(r.items.find((i) => i.key === 'comms.sms')!.detail).toContain('not message text');
  });

  it('tells enterprise users nothing personal is collected', () => {
    const r = buildTransparencyReport({ orgType: 'emi', orgName: 'Acme Finance', managedBy: 'Ops', state: initialDesiredState('emi') });
    expect(r.items.map((i) => i.key)).toEqual(expect.arrayContaining(['kiosk', 'wallpaper', 'antitamper', 'nodata']));
    expect(r.items.find((i) => i.key === 'kiosk')!.detail).toContain('Emergency calls');
  });
});
