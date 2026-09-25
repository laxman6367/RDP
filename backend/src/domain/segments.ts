export const ORG_TYPES = ['family', 'emi', 'govt', 'enterprise'] as const;
export type OrgType = (typeof ORG_TYPES)[number];

export type Capability =
  | 'kiosk'
  | 'wallpaper'
  | 'apps'
  | 'location'
  | 'camera'
  | 'comms'
  | 'social'
  | 'anti_theft'
  | 'loans';

/**
 * Feature gating by segment (spec §1, §5). Phase 2 is deliberately limited to
 * kiosk lock + wallpaper (plus loan bookkeeping for EMI, which only drives the
 * kiosk lock). No location, messaging or social monitoring in Phase 2.
 */
const CAPABILITIES: Record<OrgType, readonly Capability[]> = {
  family: ['kiosk', 'apps', 'location', 'camera', 'comms', 'social', 'anti_theft'],
  emi: ['kiosk', 'wallpaper', 'loans'],
  govt: ['kiosk', 'wallpaper'],
  enterprise: ['kiosk', 'wallpaper'],
};

export const hasCapability = (type: OrgType, cap: Capability) => CAPABILITIES[type].includes(cap);
export const capabilitiesOf = (type: OrgType) => [...CAPABILITIES[type]];
export const phaseOf = (type: OrgType): 1 | 2 => (type === 'family' ? 1 : 2);

/** Which lock modes each segment may issue (spec §4.7, §5.2). */
export type LockMode = 'kiosk' | 'payment' | 'full' | 'study';
const LOCK_MODES: Record<OrgType, readonly LockMode[]> = {
  family: ['kiosk', 'full', 'study'],
  emi: ['payment', 'kiosk', 'full'],
  govt: ['kiosk', 'full'],
  enterprise: ['kiosk', 'full'],
};
export const lockModeAllowed = (type: OrgType, mode: LockMode) => LOCK_MODES[type].includes(mode);
