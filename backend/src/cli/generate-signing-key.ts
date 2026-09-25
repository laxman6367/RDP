import { writeFileSync } from 'node:fs';
import { CommandSigner } from '../security/command-signer.js';

// Generates the ECDSA P-256 key used to sign device commands (spec §10).
// Keep the private key in your secret manager; compile the public key into the
// agent (agent/app/build.gradle.kts → REDCORE_COMMAND_PUBLIC_KEY).
const out = process.argv[2] ?? 'command-signing-key.pem';
const signer = CommandSigner.generate();
writeFileSync(out, signer.privateKeyPem(), { mode: 0o600 });
console.log(`Private key written to ${out}`);
console.log(`Public key (SPKI, base64) for the agent build:\n${signer.publicKeySpkiBase64()}`);
