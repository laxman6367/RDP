import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTx } from '../../db.js';
import { initialDesiredState, withDerived } from '../../domain/desired-state.js';
import { assertDeviceMatchesToken, assertEnrollmentAllowed, COPPA_AGE } from '../../domain/enrollment-rules.js';
import { phaseOf } from '../../domain/segments.js';
import { buildTransparencyReport } from '../../domain/transparency.js';
import { badRequest, forbidden, notFound } from '../../errors.js';
import { pairingCode, randomToken, sha256Hex } from '../../security/tokens.js';
import { audit } from '../../services/audit.js';
import { enrollmentNonce } from '../../services/integrity.js';
import { stateWithPolicy, type PolicyRow } from '../../services/policy-apply.js';
import { parse, requireAdmin, resolveOrg, type OrgRow, type Services } from '../context.js';

interface TokenRow {
  id: string;
  org_id: string;
  created_by: string;
  code: string;
  subject_label: string;
  owner_ref: string | null;
  management_mode: 'device_owner' | 'profile_owner';
  ownership: 'byod' | 'company';
  consent_type: 'guardian_of_minor' | 'company_owned';
  subject_age: number | null;
  attester_name: string;
  attestation_text: string;
  attestation_version: string;
  doc_ref: string | null;
  policy_id: string | null;
  expires_at: Date;
  used_at: Date | null;
}

export const ATTESTATION_VERSION = '2026-09-v1';

export function attestationText(orgType: OrgRow['type'], attester: string, subject: string, age?: number): string {
  if (orgType === 'family') {
    return (
      `I, ${attester}, confirm that I am the parent or legal guardian of ${subject}` +
      (age !== undefined ? `, aged ${age},` : '') +
      ` and that ${subject} will be told this device is managed by Redcore. ` +
      `A persistent notice will always be shown on the device.` +
      (age !== undefined && age < COPPA_AGE ? ' I give verifiable parental consent for the collection described (COPPA).' : '')
    );
  }
  return (
    `I, ${attester}, confirm on behalf of the organization that this device is company-owned ` +
    `(financed, issued or corporate), that ${subject} has been informed of the management and locking terms, ` +
    `and that emergency calling will remain available at all times.`
  );
}

export async function enrollmentRoutes(app: FastifyInstance, s: Services) {
  app.post('/enrollment-tokens', async (req, reply) => {
    const admin = await requireAdmin(s, req, 'manage');
    const org = await resolveOrg(s, req, admin);
    const body = parse(
      z.object({
        subjectLabel: z.string().min(1).max(120),
        ownerRef: z.string().max(120).optional(),
        managementMode: z.enum(['device_owner', 'profile_owner']),
        ownership: z.enum(['byod', 'company']),
        consentType: z.enum(['guardian_of_minor', 'company_owned']),
        subjectAge: z.number().int().min(0).max(120).optional(),
        guardianAttestation: z.literal(true, { error: 'You must confirm the attestation' }),
        coppaParentalConsent: z.boolean().optional(),
        attesterName: z.string().min(2).max(120),
        docRef: z.string().max(500).optional(),
        policyId: z.uuid().optional(),
        ttlHours: z.number().int().min(1).max(24 * 14).default(72),
      }),
      req.body,
    );
    const { coppaApplicable } = assertEnrollmentAllowed(org.type, body);
    if (body.policyId) {
      const p = await s.db.query('select 1 from policies where id = $1 and org_id = $2', [body.policyId, org.id]);
      if (!p.rowCount) throw notFound('policy');
    }
    const text = attestationText(org.type, body.attesterName, body.subjectLabel, body.subjectAge);
    const expiresAt = new Date(Date.now() + body.ttlHours * 3_600_000);

    const token = await withTx(s.db, async (tx) => {
      // Retry on the (unlikely) collision with another live 6-digit code.
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = pairingCode();
        const res = await tx.query<TokenRow>(
          `insert into enrollment_tokens (org_id, created_by, code, subject_label, owner_ref, management_mode, ownership,
             consent_type, subject_age, attester_name, attestation_text, attestation_version, doc_ref, policy_id, expires_at)
           select $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
           where not exists (select 1 from enrollment_tokens where code = $3)
           returning *`,
          [org.id, admin.id, code, body.subjectLabel, body.ownerRef ?? null, body.managementMode, body.ownership, body.consentType,
            body.subjectAge ?? null, body.attesterName, text, ATTESTATION_VERSION, body.docRef ?? null, body.policyId ?? null, expiresAt],
        );
        if (res.rows[0]) {
          await audit(tx, { orgId: org.id, actor: { type: 'admin', id: admin.id }, action: 'enrollment.token_created', targetType: 'enrollment_token', targetId: res.rows[0].id, meta: { subjectLabel: body.subjectLabel, managementMode: body.managementMode, coppaApplicable }, ip: req.ip });
          return res.rows[0];
        }
      }
      throw new Error('could not allocate a pairing code');
    });

    reply.code(201);
    return {
      id: token.id,
      code: token.code,
      expiresAt: token.expires_at,
      attestationText: text,
      coppaApplicable,
      // Scanned by the Redcore app after install (Profile Owner / guided setup, spec §4.1).
      pairingQr: JSON.stringify({ redcore: 1, server: s.cfg.PUBLIC_BASE_URL, code: token.code }),
      // Scanned at the factory-reset welcome screen to provision Device Owner (spec §5.1).
      provisioningQr:
        token.management_mode === 'device_owner'
          ? JSON.stringify({
              'android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME': s.cfg.AGENT_ADMIN_COMPONENT,
              'android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION': s.cfg.AGENT_APK_URL,
              'android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM': s.cfg.AGENT_APK_SIGNATURE_CHECKSUM,
              'android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED': true,
              'android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE': {
                'com.redcore.agent.SERVER_URL': s.cfg.PUBLIC_BASE_URL,
                'com.redcore.agent.ENROLL_CODE': token.code,
              },
            })
          : null,
    };
  });

  app.get('/enrollment-tokens', async (req) => {
    const admin = await requireAdmin(s, req, 'manage');
    const org = await resolveOrg(s, req, admin);
    const { rows } = await s.db.query(
      `select id, code, subject_label as "subjectLabel", management_mode as "managementMode", expires_at as "expiresAt",
              used_at as "usedAt", device_id as "deviceId", created_at as "createdAt"
       from enrollment_tokens where org_id = $1 order by created_at desc limit 100`,
      [org.id],
    );
    return { tokens: rows };
  });

  app.delete<{ Params: { id: string } }>('/enrollment-tokens/:id', async (req) => {
    const admin = await requireAdmin(s, req, 'manage');
    const org = await resolveOrg(s, req, admin);
    await withTx(s.db, async (tx) => {
      const res = await tx.query('update enrollment_tokens set expires_at = now() where id = $1 and org_id = $2 and used_at is null', [req.params.id, org.id]);
      if (!res.rowCount) throw notFound('enrollment token');
      await audit(tx, { orgId: org.id, actor: { type: 'admin', id: admin.id }, action: 'enrollment.token_revoked', targetType: 'enrollment_token', targetId: req.params.id, ip: req.ip });
    });
    return { ok: true };
  });

  /** Public: shows the device holder who is enrolling them and what they attested, before they accept. */
  app.get<{ Params: { code: string } }>('/enroll/:code', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { rows } = await s.db.query<TokenRow & { org_name: string; org_type: OrgRow['type'] }>(
      `select t.*, o.name as org_name, o.type as org_type from enrollment_tokens t join organizations o on o.id = t.org_id
       where t.code = $1 and t.used_at is null and t.expires_at > now()`,
      [req.params.code],
    );
    const t = rows[0];
    if (!t) throw notFound('enrollment code');
    return {
      organization: t.org_name,
      organizationType: t.org_type,
      managedBy: t.attester_name,
      subjectLabel: t.subject_label,
      managementMode: t.management_mode,
      attestationText: t.attestation_text,
      integrityNonce: enrollmentNonce(t.code),
    };
  });

  app.post('/enroll', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parse(
      z.object({
        code: z.string().regex(/^\d{6}$/),
        holderAcknowledged: z.boolean(),
        holderName: z.string().max(120).optional(),
        isDeviceOwner: z.boolean(),
        isProfileOwner: z.boolean(),
        device: z.object({
          manufacturer: z.string().max(80),
          model: z.string().max(80),
          osVersion: z.string().max(40),
          sdkInt: z.number().int().min(26),
          agentVersion: z.string().max(40),
        }),
        fcmToken: z.string().max(4096).optional(),
        integrityToken: z.string().max(20000).optional(),
      }),
      req.body,
    );

    const preview = (await s.db.query<TokenRow>('select * from enrollment_tokens where code = $1', [body.code])).rows[0];
    if (!preview || preview.used_at || preview.expires_at < new Date()) throw notFound('enrollment code');
    assertDeviceMatchesToken(preview, body);
    const verdict = await s.integrity.verify(body.integrityToken, enrollmentNonce(body.code));
    if (verdict.status === 'failed' && s.cfg.INTEGRITY_ENFORCE) {
      throw forbidden('INTEGRITY_FAILED', 'This device did not pass Play Integrity attestation');
    }

    const credential = randomToken('rcd', 32);
    const result = await withTx(s.db, async (tx) => {
      const token = (await tx.query<TokenRow>('select * from enrollment_tokens where id = $1 for update', [preview.id])).rows[0]!;
      if (token.used_at || token.expires_at < new Date()) throw badRequest('ENROLLMENT_CODE_USED');
      const org = (await tx.query<OrgRow>('select * from organizations where id = $1', [token.org_id])).rows[0]!;

      const device = (
        await tx.query<{ id: string }>(
          `insert into devices (org_id, owner_ref, display_name, manufacturer, model, os_version, sdk_int, agent_version,
             ownership, management_mode, fcm_token, credential_hash, integrity_verdict, desired_state, last_seen)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now()) returning id`,
          [org.id, token.owner_ref, token.subject_label, body.device.manufacturer, body.device.model, body.device.osVersion,
            body.device.sdkInt, body.device.agentVersion, token.ownership, token.management_mode, body.fcmToken ?? null,
            sha256Hex(credential), verdict, initialDesiredState(org.type)],
        )
      ).rows[0]!;

      let state = initialDesiredState(org.type);
      if (token.policy_id) {
        const policy = (await tx.query<PolicyRow>('select * from policies where id = $1', [token.policy_id])).rows[0] ?? null;
        if (policy && policy.phase === phaseOf(org.type)) {
          state = withDerived(await stateWithPolicy(tx, device.id, state, policy));
          await tx.query('insert into device_policy (device_id, policy_id) values ($1, $2)', [device.id, policy.id]);
        }
      }
      await tx.query('update devices set desired_state = $2, desired_version = $3 where id = $1', [device.id, state, state.version]);

      const consent = (
        await tx.query<{ id: string }>(
          `insert into consents (org_id, device_id, type, attested_by, attester_name, subject_label, subject_age, coppa_applicable,
             attestation_text, attestation_version, doc_ref, device_acknowledged_at, device_holder_name)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), $12) returning id`,
          [org.id, device.id, token.consent_type, token.created_by, token.attester_name, token.subject_label, token.subject_age,
            token.subject_age !== null && token.subject_age < COPPA_AGE, token.attestation_text, token.attestation_version,
            token.doc_ref, body.holderName ?? null],
        )
      ).rows[0]!;
      await tx.query('update devices set consent_id = $2 where id = $1', [device.id, consent.id]);
      await tx.query('update enrollment_tokens set used_at = now(), device_id = $2 where id = $1', [token.id, device.id]);
      if (verdict.status === 'failed') {
        await tx.query("insert into alerts (org_id, device_id, kind, payload) values ($1, $2, 'tamper', $3)", [
          org.id, device.id, { reason: 'integrity_failed', verdict },
        ]);
      }
      await audit(tx, { orgId: org.id, actor: { type: 'device', id: device.id }, action: 'device.enrolled', targetType: 'device', targetId: device.id, meta: { tokenId: token.id, consentId: consent.id, integrity: verdict.status, model: body.device.model }, ip: req.ip });
      return { deviceId: device.id, org, token, state };
    });

    reply.code(201);
    return {
      deviceId: result.deviceId,
      deviceCredential: credential,
      commandPublicKey: s.signer.publicKeySpkiBase64(),
      state: s.commands.signState(result.deviceId, result.state),
      transparency: buildTransparencyReport({
        orgType: result.org.type,
        orgName: result.org.name,
        managedBy: result.token.attester_name,
        state: result.state,
      }),
    };
  });
}
