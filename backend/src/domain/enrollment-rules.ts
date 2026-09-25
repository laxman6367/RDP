import { badRequest, forbidden } from '../errors.js';
import { phaseOf, type OrgType } from './segments.js';

export interface EnrollmentTokenInput {
  managementMode: 'device_owner' | 'profile_owner';
  ownership: 'byod' | 'company';
  consentType: 'guardian_of_minor' | 'company_owned';
  subjectAge?: number | undefined;
  guardianAttestation: boolean;
  coppaParentalConsent?: boolean | undefined;
}

export const ADULT_AGE = 18;
export const COPPA_AGE = 13;

/**
 * Anti-abuse gate (spec §3.1, §3.5, §13). Refuses enrollment patterns that
 * look like covert adult surveillance:
 *  - family orgs may only enroll a minor, with an explicit guardianship attestation;
 *  - Phase 2 orgs may only enroll company-owned devices as Device Owner.
 */
export function assertEnrollmentAllowed(orgType: OrgType, input: EnrollmentTokenInput): { coppaApplicable: boolean } {
  if (phaseOf(orgType) === 1) {
    if (input.consentType !== 'guardian_of_minor') {
      throw forbidden('CONSENT_TYPE_INVALID', 'Parental enrollment requires a guardian-of-minor attestation');
    }
    if (!input.guardianAttestation) {
      throw badRequest('ATTESTATION_REQUIRED', 'The enrolling adult must attest legal guardianship of the child');
    }
    if (input.subjectAge === undefined) throw badRequest('SUBJECT_AGE_REQUIRED', "The child's age is required");
    if (input.subjectAge >= ADULT_AGE) {
      throw forbidden(
        'ADULT_SUBJECT_NOT_ALLOWED',
        'Parental control can only be used for a minor. Adult devices can only be managed when company-owned.',
      );
    }
    const coppaApplicable = input.subjectAge < COPPA_AGE;
    if (coppaApplicable && !input.coppaParentalConsent) {
      throw badRequest('COPPA_CONSENT_REQUIRED', 'Verifiable parental consent is required for children under 13');
    }
    return { coppaApplicable };
  }

  if (input.consentType !== 'company_owned' || input.ownership !== 'company') {
    throw forbidden('COMPANY_OWNERSHIP_REQUIRED', 'Enterprise devices must be company-owned');
  }
  if (input.managementMode !== 'device_owner') {
    throw forbidden('DEVICE_OWNER_REQUIRED', 'Enterprise devices must be enrolled as Device Owner');
  }
  if (!input.guardianAttestation) {
    throw badRequest('ATTESTATION_REQUIRED', 'The organization must attest company ownership and disclosure of terms');
  }
  return { coppaApplicable: false };
}

export interface DeviceEnrollmentReport {
  holderAcknowledged: boolean;
  isDeviceOwner: boolean;
  isProfileOwner: boolean;
}

/** The device side of the consent gate: the holder saw the notice, and the DPC mode matches. */
export function assertDeviceMatchesToken(
  token: { management_mode: 'device_owner' | 'profile_owner' },
  report: DeviceEnrollmentReport,
): void {
  if (!report.holderAcknowledged) {
    throw badRequest('HOLDER_ACKNOWLEDGEMENT_REQUIRED', 'The device holder must acknowledge the management notice');
  }
  if (token.management_mode === 'device_owner' && !report.isDeviceOwner) {
    throw forbidden('DEVICE_OWNER_REQUIRED', 'This enrollment requires Redcore to be provisioned as Device Owner');
  }
  if (token.management_mode === 'profile_owner' && !report.isProfileOwner && !report.isDeviceOwner) {
    throw forbidden('PROFILE_OWNER_REQUIRED', 'This enrollment requires Redcore to be provisioned as Profile Owner');
  }
}
