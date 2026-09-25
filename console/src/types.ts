export type OrgType = 'family' | 'emi' | 'govt' | 'enterprise';
export type Capability = 'kiosk' | 'wallpaper' | 'apps' | 'location' | 'camera' | 'comms' | 'social' | 'anti_theft' | 'loans';

export interface Org {
  id: string;
  type: OrgType;
  name: string;
  region: string;
  retentionDays: number;
  phase: 1 | 2;
  capabilities: Capability[];
  webhookConfigured: boolean;
  webhookUrl: string | null;
  commandPublicKey: string;
}

export interface Me {
  admin: { id: string; orgId: string | null; role: 'super_admin' | 'org_admin' | 'operator' | 'read_only'; email: string; displayName: string; mfa: boolean; mfaEnabled: boolean };
  mfaRequired: boolean;
}

export interface DeviceSummary {
  id: string;
  displayName: string;
  ownerRef: string | null;
  model: string | null;
  manufacturer: string | null;
  osVersion: string | null;
  agentVersion: string | null;
  status: 'active' | 'retired';
  managementMode: 'device_owner' | 'profile_owner';
  ownership: 'byod' | 'company';
  lastSeen: string | null;
  enrolledAt: string;
  kioskMode: string;
  policyName: string | null;
  desiredVersion: number;
  reportedVersion: number;
  inSync: boolean;
  integrity: string;
}

export interface TransparencyReport {
  managedBy: string;
  organization: string;
  headline: string;
  items: Array<{ key: string; title: string; detail: string }>;
}

export interface Policy {
  id: string;
  name: string;
  phase: 1 | 2;
  version: number;
  spec: any;
  deviceCount?: number;
  updatedAt: string;
}

export interface Wallpaper {
  id: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

export interface Loan {
  id: string;
  deviceId: string;
  deviceName: string | null;
  accountRef: string;
  currency: string;
  status: 'active' | 'closed';
  tier: 'ok' | 'reminder' | 'nag' | 'hard_lock';
  overdueDays: number;
  nextDueDate: string | null;
  amountDue: number;
  reminderDays: number;
  graceDays: number;
  hardLockAfterDays: number;
  supportContact: string;
  paymentUrl: string | null;
  autoLockPaused: boolean;
  installments: Array<{ id: string; seq: number; dueDate: string; amount: number; paidAt: string | null; paymentRef: string | null }>;
  payments?: Array<{ paymentRef: string; amount: number; paidAt: string }>;
}

export interface Alert {
  id: string;
  deviceId: string;
  deviceName: string;
  kind: string;
  payload: Record<string, unknown>;
  ts: string;
  acknowledgedAt: string | null;
}
