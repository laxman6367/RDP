import type { EnterprisePolicy, FamilyPolicy, PolicySpec } from './policy.js';
import { phaseOf, type OrgType } from './segments.js';

/**
 * An explicit lock issued by an admin or by the EMI loan rules. Scheduled study
 * mode and enforced enterprise kiosks come from the policy and are resolved on
 * the device (they depend on the device clock), with this override taking
 * precedence (see agent `KioskResolver`).
 */
export interface KioskOverride {
  mode: 'none' | 'single_purpose' | 'full' | 'study' | 'payment_due' | 'payment_nag';
  allowlist: string[];
  message?: string;
  supportContact?: string;
  paymentUrl?: string;
  amountDue?: { amount: number; currency: string; dueDate: string };
  source: 'admin' | 'loan_rule' | 'none';
}

export interface WallpaperState {
  wallpaperId: string;
  /** Path the agent fetches with its device credential. */
  path: string;
  sha256: string;
  target: 'home' | 'lock' | 'both';
  lockChange: boolean;
  /** 'policy' = fleet default from the assigned policy; 'admin' = set for this device and kept across policy changes. */
  source: 'admin' | 'policy';
}

/** A non-blocking notice the agent shows as a notification (e.g. EMI payment reminders, spec §5.2A). */
export interface DeviceNotice {
  kind: 'payment_reminder';
  title: string;
  body: string;
  dueDate?: string;
  amount?: number;
  currency?: string;
}

export interface DesiredState {
  version: number;
  phase: 1 | 2;
  kiosk: KioskOverride;
  wallpaper: WallpaperState | null;
  policy: { id: string; version: number; spec: PolicySpec } | null;
  /** Android user restrictions (UserManager.DISALLOW_*) the agent must hold. */
  userRestrictions: string[];
  notice: DeviceNotice | null;
  /** Set when the device is retired: the agent lifts every restriction and releases management. */
  released: boolean;
}

export const NO_KIOSK: KioskOverride = { mode: 'none', allowlist: [], source: 'none' };

export function initialDesiredState(orgType: OrgType): DesiredState {
  return withDerived(
    { version: 1, phase: phaseOf(orgType), kiosk: NO_KIOSK, wallpaper: null, policy: null, userRestrictions: [], notice: null, released: false },
  );
}

/** Recomputes fields derived from the policy and wallpaper. */
export function withDerived(state: DesiredState): DesiredState {
  const r = new Set<string>();
  if (!state.released) {
    if (state.phase === 2) {
      // Phase 2 devices are company-owned Device Owner devices: anti-tamper is on
      // by default (spec §5.1) unless a policy explicitly turns a switch off.
      const at = (state.policy?.spec as EnterprisePolicy | undefined)?.antiTamper;
      if (at?.disallowFactoryReset ?? true) r.add('no_factory_reset');
      if (at?.disallowSafeBoot ?? true) r.add('no_safe_boot');
      if (at?.disallowAddUser ?? true) r.add('no_add_user');
      r.add('no_uninstall_apps_redcore');
    } else {
      const fam = state.policy?.spec as FamilyPolicy | undefined;
      if (fam?.apps.requireInstallApproval) r.add('no_install_apps');
    }
    if (state.wallpaper?.lockChange) r.add('no_set_wallpaper');
  }
  return { ...state, userRestrictions: [...r].sort() };
}
