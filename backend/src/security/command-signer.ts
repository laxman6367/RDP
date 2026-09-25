import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Signs command envelopes with ECDSA P-256 / SHA-256 (spec §10 "Signed commands").
 *
 * The agent receives the exact envelope string plus a DER signature and verifies
 * the bytes with the public key compiled into the app, so no JSON
 * canonicalisation is needed on either side. ECDSA P-256 is used because
 * `SHA256withECDSA` is available on every Android version the agent supports.
 */
export class CommandSigner {
  private constructor(
    private readonly privateKey: KeyObject,
    readonly publicKey: KeyObject,
  ) {}

  static fromPem(pem: string): CommandSigner {
    const priv = createPrivateKey(pem);
    return new CommandSigner(priv, createPublicKey(priv));
  }

  static fromConfig(opts: { pem?: string; file?: string; allowEphemeral: boolean }): CommandSigner {
    if (opts.pem) return CommandSigner.fromPem(opts.pem.replace(/\\n/g, '\n'));
    if (opts.file) return CommandSigner.fromPem(readFileSync(opts.file, 'utf8'));
    if (!opts.allowEphemeral) throw new Error('No command signing key configured');
    return CommandSigner.generate();
  }

  static generate(): CommandSigner {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    return new CommandSigner(privateKey, publicKey);
  }

  sign(envelope: string): string {
    return sign('sha256', Buffer.from(envelope, 'utf8'), this.privateKey).toString('base64');
  }

  verify(envelope: string, signatureB64: string): boolean {
    return verify('sha256', Buffer.from(envelope, 'utf8'), this.publicKey, Buffer.from(signatureB64, 'base64'));
  }

  /** X.509 SubjectPublicKeyInfo, base64 DER — the format Android's X509EncodedKeySpec expects. */
  publicKeySpkiBase64(): string {
    return this.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  }

  privateKeyPem(): string {
    return this.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  }
}
