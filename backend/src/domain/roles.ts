export const ROLES = ['super_admin', 'org_admin', 'operator', 'read_only'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Least-privilege permission tiers (spec §6, §10).
 * - read:    view fleet, devices, reports, audit
 * - command: lock/unlock, wallpaper, locate, acknowledge alerts
 * - manage:  policies, enrollment, loans, admins, data deletion, retire
 */
export type Permission = 'read' | 'command' | 'manage';

const GRANTS: Record<Role, readonly Permission[]> = {
  super_admin: ['read', 'command', 'manage'],
  org_admin: ['read', 'command', 'manage'],
  operator: ['read', 'command'],
  read_only: ['read'],
};

export const roleHas = (role: Role, perm: Permission) => GRANTS[role].includes(perm);
