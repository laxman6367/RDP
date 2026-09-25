import { createHash } from 'node:crypto';
import type { GoogleAuth } from './google-auth.js';

export interface IntegrityVerdict {
  status: 'verified' | 'failed' | 'unverified';
  reason?: string;
  deviceRecognition?: string[];
  appRecognition?: string;
  checkedAt: string;
}

/** Nonce the agent must pass to the Play Integrity API when enrolling with `code`. */
export const enrollmentNonce = (code: string) =>
  createHash('sha256').update(`redcore-enroll:${code}`).digest('base64url');

export interface IntegrityVerifier {
  verify(token: string | undefined, expectedNonce: string): Promise<IntegrityVerdict>;
}

/** Used when no Google credentials are configured: records that attestation was not performed. */
export class NoopIntegrityVerifier implements IntegrityVerifier {
  async verify(): Promise<IntegrityVerdict> {
    return { status: 'unverified', reason: 'play_integrity_not_configured', checkedAt: new Date().toISOString() };
  }
}

export class PlayIntegrityVerifier implements IntegrityVerifier {
  constructor(
    private readonly auth: GoogleAuth,
    private readonly packageName: string,
  ) {}

  async verify(token: string | undefined, expectedNonce: string): Promise<IntegrityVerdict> {
    const checkedAt = new Date().toISOString();
    if (!token) return { status: 'failed', reason: 'missing_token', checkedAt };
    const access = await this.auth.accessToken('https://www.googleapis.com/auth/playintegrity');
    const res = await fetch(`https://playintegrity.googleapis.com/v1/${this.packageName}:decodeIntegrityToken`, {
      method: 'POST',
      headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
      body: JSON.stringify({ integrity_token: token }),
    });
    if (!res.ok) return { status: 'failed', reason: `decode_failed_${res.status}`, checkedAt };
    const body = (await res.json()) as {
      tokenPayloadExternal?: {
        requestDetails?: { nonce?: string; requestPackageName?: string };
        appIntegrity?: { appRecognitionVerdict?: string };
        deviceIntegrity?: { deviceRecognitionVerdict?: string[] };
      };
    };
    const p = body.tokenPayloadExternal ?? {};
    const deviceRecognition = p.deviceIntegrity?.deviceRecognitionVerdict ?? [];
    const appRecognition = p.appIntegrity?.appRecognitionVerdict;
    const base = { deviceRecognition, appRecognition, checkedAt };
    if (p.requestDetails?.nonce !== expectedNonce) return { ...base, status: 'failed', reason: 'nonce_mismatch' };
    if (p.requestDetails?.requestPackageName !== this.packageName) return { ...base, status: 'failed', reason: 'package_mismatch' };
    if (!deviceRecognition.includes('MEETS_DEVICE_INTEGRITY')) return { ...base, status: 'failed', reason: 'device_integrity' };
    if (appRecognition !== 'PLAY_RECOGNIZED') return { ...base, status: 'failed', reason: 'app_not_recognized' };
    return { ...base, status: 'verified' };
  }
}
