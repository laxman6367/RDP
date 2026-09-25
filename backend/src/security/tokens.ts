import { createHash, randomBytes, randomInt } from 'node:crypto';

export const sha256Hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** Opaque bearer secret with a type prefix, e.g. `rcd_…` for device credentials. */
export const randomToken = (prefix: string, bytes = 32) => `${prefix}_${randomBytes(bytes).toString('base64url')}`;

/** Human-enterable 6-digit pairing code (spec §4.1). Uniqueness is enforced by the DB. */
export const pairingCode = () => randomInt(0, 1_000_000).toString().padStart(6, '0');
