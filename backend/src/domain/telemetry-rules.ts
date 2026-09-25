import type { DesiredState } from './desired-state.js';
import type { FamilyPolicy } from './policy.js';

export const TELEMETRY_KINDS = ['app_inventory', 'app_usage', 'location', 'sms', 'call_log', 'contacts'] as const;
export type TelemetryKind = (typeof TELEMETRY_KINDS)[number];

export const ALERT_KINDS = [
  'geofence_enter',
  'geofence_exit',
  'sos',
  'keyword',
  'unknown_number',
  'install_request',
  'limit_reached',
  'permission_denied',
  'tamper',
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

const familyPolicy = (s: DesiredState): FamilyPolicy | null => (s.phase === 1 ? ((s.policy?.spec as FamilyPolicy) ?? null) : null);

/**
 * Data minimization (spec §3.4): the server only accepts telemetry the active
 * policy asked for. Phase 2 devices never send telemetry.
 */
export function telemetryAllowed(state: DesiredState, kind: TelemetryKind): boolean {
  if (state.released) return false;
  const p = familyPolicy(state);
  if (state.phase !== 1) return false;
  switch (kind) {
    case 'app_inventory':
    case 'app_usage':
      return p ? p.apps.reportUsage : true;
    case 'location':
      return !!p?.location.enabled;
    case 'sms':
      return !!p && p.comms.sms !== 'off';
    case 'call_log':
      return !!p?.comms.callLog;
    case 'contacts':
      return !!p?.comms.contacts;
  }
}

export function alertAllowed(state: DesiredState, kind: AlertKind): boolean {
  if (kind === 'tamper' || kind === 'permission_denied') return true;
  if (state.phase !== 1 || state.released) return false;
  const p = familyPolicy(state);
  switch (kind) {
    case 'geofence_enter':
    case 'geofence_exit':
      return !!p?.location.enabled;
    case 'sos':
      return p ? p.location.sosEnabled : true;
    case 'keyword':
      return !!p && (p.comms.keywordAlerts || p.social.notificationSafetySignals);
    case 'unknown_number':
      return !!p?.comms.unknownNumberAlerts;
    case 'install_request':
      return !!p?.apps.requireInstallApproval;
    case 'limit_reached':
      return true;
  }
}

/** Strips SMS bodies unless the policy explicitly allows content visibility. */
export function minimizePayload(state: DesiredState, kind: TelemetryKind, payload: Record<string, unknown>): Record<string, unknown> {
  if (kind === 'sms' && familyPolicy(state)?.comms.sms !== 'content') {
    const { body: _body, ...rest } = payload;
    return rest;
  }
  return payload;
}
