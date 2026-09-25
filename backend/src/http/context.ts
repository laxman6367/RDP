import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import type { DesiredState } from '../domain/desired-state.js';
import { roleHas, type Permission, type Role } from '../domain/roles.js';
import { hasCapability, type Capability, type OrgType } from '../domain/segments.js';
import { badRequest, forbidden, notFound, unauthorized } from '../errors.js';
import type { CommandSigner } from '../security/command-signer.js';
import type { JwtService } from '../security/jwt.js';
import { sha256Hex } from '../security/tokens.js';
import type { BlobStore } from '../services/blob-store.js';
import type { CommandService } from '../services/commands.js';
import type { IntegrityVerifier } from '../services/integrity.js';
import type { LoanService } from '../services/loans.js';
import type { PushService } from '../services/push.js';

export interface Services {
  cfg: Config;
  db: Db;
  jwt: JwtService;
  signer: CommandSigner;
  commands: CommandService;
  loans: LoanService;
  push: PushService;
  blobs: BlobStore;
  integrity: IntegrityVerifier;
}

export interface AdminPrincipal {
  id: string;
  orgId: string | null;
  role: Role;
  email: string;
  displayName: string;
  mfa: boolean;
}

export interface OrgRow {
  id: string;
  type: OrgType;
  name: string;
  region: string;
  retention_days: number;
  webhook_secret: string | null;
  created_at: Date;
}

export interface DeviceRow {
  id: string;
  org_id: string;
  owner_ref: string | null;
  display_name: string;
  manufacturer: string | null;
  model: string | null;
  os_version: string | null;
  sdk_int: number | null;
  agent_version: string | null;
  enroll_ts: Date;
  consent_id: string | null;
  ownership: 'byod' | 'company';
  management_mode: 'device_owner' | 'profile_owner';
  fcm_token: string | null;
  status: 'active' | 'retired';
  last_seen: Date | null;
  integrity_verdict: Record<string, unknown> | null;
  desired_state: DesiredState;
  desired_version: number;
  reported_state: Record<string, unknown> | null;
  reported_version: number;
  created_at: Date;
}

declare module 'fastify' {
  interface FastifyRequest {
    admin: AdminPrincipal | null;
    device: DeviceRow | null;
    rawBody?: string;
  }
}

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw badRequest(
      'VALIDATION_FAILED',
      'Request validation failed',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}

const bearer = (req: FastifyRequest): string | null => {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return null;
  return h.slice(7).trim();
};

export const isDeviceCredential = (req: FastifyRequest) => bearer(req)?.startsWith('rcd_') ?? false;

/** Authenticates a console admin from the access token. `allowWithoutMfa` is only for MFA enrollment routes. */
export async function authenticateAdmin(s: Services, req: FastifyRequest, allowWithoutMfa = false): Promise<AdminPrincipal> {
  const token = bearer(req);
  if (!token || token.startsWith('rcd_')) throw unauthorized();
  let claims;
  try {
    claims = await s.jwt.verify(token);
  } catch {
    throw unauthorized('TOKEN_INVALID');
  }
  const { rows } = await s.db.query<{ id: string; org_id: string | null; role: Role; email: string; display_name: string; disabled_at: Date | null }>(
    'select id, org_id, role, email, display_name, disabled_at from admins where id = $1',
    [claims.sub],
  );
  const row = rows[0];
  if (!row || row.disabled_at) throw unauthorized('ADMIN_DISABLED');
  if (s.cfg.REQUIRE_MFA && !claims.mfa && !allowWithoutMfa) {
    throw forbidden('MFA_REQUIRED', 'Complete multi-factor authentication to continue');
  }
  const admin = { id: row.id, orgId: row.org_id, role: row.role, email: row.email, displayName: row.display_name, mfa: claims.mfa };
  req.admin = admin;
  return admin;
}

export async function requireAdmin(s: Services, req: FastifyRequest, perm: Permission): Promise<AdminPrincipal> {
  const admin = await authenticateAdmin(s, req);
  if (!roleHas(admin.role, perm)) throw forbidden('INSUFFICIENT_ROLE', `This action requires the "${perm}" permission`);
  return admin;
}

/** Resolves the org an admin acts on. Super admins pick one with `?orgId=`. */
export async function resolveOrg(s: Services, req: FastifyRequest, admin: AdminPrincipal): Promise<OrgRow> {
  let orgId = admin.orgId;
  if (admin.role === 'super_admin') {
    const q = (req.query as { orgId?: string } | undefined)?.orgId;
    if (q) orgId = q;
  }
  if (!orgId) throw badRequest('ORG_REQUIRED', 'Specify ?orgId= for this super-admin request');
  const { rows } = await s.db.query<OrgRow>('select * from organizations where id = $1', [orgId]);
  if (!rows[0]) throw notFound('organization');
  return rows[0];
}

export function requireCapability(org: OrgRow, cap: Capability): void {
  if (!hasCapability(org.type, cap)) {
    throw forbidden('FEATURE_NOT_AVAILABLE', `"${cap}" is not available for ${org.type} organizations`);
  }
}

/** Loads a device the admin is allowed to see, with its org. */
export async function loadDeviceForAdmin(
  s: Services,
  admin: AdminPrincipal,
  deviceId: string,
): Promise<{ device: DeviceRow; org: OrgRow }> {
  if (!/^[0-9a-f-]{36}$/i.test(deviceId)) throw notFound('device');
  const { rows } = await s.db.query<DeviceRow>('select * from devices where id = $1', [deviceId]);
  const device = rows[0];
  if (!device || (admin.role !== 'super_admin' && device.org_id !== admin.orgId)) throw notFound('device');
  const org = (await s.db.query<OrgRow>('select * from organizations where id = $1', [device.org_id])).rows[0]!;
  return { device, org };
}

/** Authenticates the agent by its device credential and checks it matches the `:id` in the path. */
export async function requireDevice(s: Services, req: FastifyRequest, deviceId: string): Promise<DeviceRow> {
  const token = bearer(req);
  if (!token?.startsWith('rcd_')) throw unauthorized();
  const { rows } = await s.db.query<DeviceRow>("select * from devices where credential_hash = $1 and status = 'active'", [
    sha256Hex(token),
  ]);
  const device = rows[0];
  if (!device || device.id !== deviceId) throw unauthorized('DEVICE_CREDENTIAL_INVALID');
  req.device = device;
  return device;
}

export const idempotencyKey = (req: FastifyRequest): string | undefined => {
  const v = req.headers['idempotency-key'];
  const key = Array.isArray(v) ? v[0] : v;
  if (key && key.length > 128) throw badRequest('IDEMPOTENCY_KEY_TOO_LONG');
  return key || undefined;
};

export const sendCsv = (reply: FastifyReply, filename: string, header: string[], rows: unknown[][]) => {
  const esc = (v: unknown) => {
    const str = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${filename}"`);
  return [header, ...rows].map((r) => r.map(esc).join(',')).join('\n');
};
