<p align="center"><img src="docs/assets/redcore-logo.png" alt="Redcore MDM" width="420"></p>

# Redcore

Redcore is a consent-based Android device management platform. Parents use it to manage a child's phone (Phase 1), and EMI financiers, government departments and companies use it to manage company-owned devices (Phase 2). The full product specification is in [`docs/SPEC.md`](docs/SPEC.md).

Redcore is transparent by design. A device only comes under management after an explicit enrollment in which the admin records their attestation and the device holder acknowledges a notice. Devices always show that they are managed. Covert or "stealth" operation is out of scope (spec §13).

## Repository layout

| Path | What it is | Status |
|------|------------|--------|
| `backend/` | API server: Node.js 22, Fastify, PostgreSQL | Implemented and tested (63 tests) |
| `console/` | Admin web console: React, Vite, TypeScript | Implemented; the policy builder is read-only (see below) |
| `agent/core/` | Pure-Kotlin logic for the Android agent | Signature verification and command guard, tested |
| `agent/app/` | Android device agent | **Not started** |
| `docs/` | Specification, logo, screenshots | |

## What works today

**Enrollment & consent (spec §3.1, §3.5, §4.1, §5.1)**
- Admins generate a single-use 6-digit pairing code. The console shows it with a pairing QR and, for Device Owner setups, an Android provisioning QR.
- Parental plans only accept a minor (under 18) with a guardianship attestation. Under-13s also need verifiable parental consent (COPPA).
- Phase 2 plans only accept company-owned devices enrolled as Device Owner.
- The device must report that the holder acknowledged the notice and that its management mode matches the enrollment.
- A consent record is stored for every device, and a Play Integrity verdict is recorded (optionally enforced).

**Commands & reconciliation (spec §7, §10)**
- Each device has a desired state (lock, wallpaper, policy, restrictions, notices). Every change bumps a version and queues a signed `APPLY_STATE` command.
- Heartbeats return the full signed state to any device that is behind, so offline devices catch up.
- The command queue is durable, idempotent (via the `Idempotency-Key` header), acknowledged, and retried with backoff; commands expire.
- Commands are signed with ECDSA P-256. The agent verifies them against a public key it holds.
- A silent FCM push wakes the device; the command data is always pulled over HTTPS.

**Phase 2: kiosk lock & wallpaper (spec §5)**
- Admins can apply a kiosk lock (allow-listed apps) or a full lock, per device or in bulk. Anti-tamper restrictions are on by default for Phase 2 devices.
- EMI loan accounts carry installment schedules. The reminder → reminder screen → payment-due lock stages are recomputed by a background job.
- An HMAC-signed payment webhook (with replay protection) marks installments paid and unlocks the device automatically.
- Loan rules never override a lock placed by an admin, and auto-lock can be paused per account.
- Wallpapers can be uploaded, set per device or as a fleet default in a policy, and optionally locked so the user can't change them.

**Phase 1: parental control (spec §4)**
- The backend models, validates and enforces family policies. It only accepts telemetry and alerts that the active policy enables (data minimization), and drops SMS text unless content visibility is explicitly enabled.
- It also supports on-demand locate, lost-device mode (disclosed to the device holder and audited), retention-based deletion, data export and deletion.
- The console shows screen time, a location map and alerts.

**Transparency & audit (spec §3.2, §6)**
- Admins and the device get the same plain-language "what is managed" report.
- Every admin, device, system and webhook action is written to the audit log, which can be exported as CSV.
- Roles: org admin, operator, read-only. TOTP MFA is required for every admin.

## Known gaps

- **Policy builder in the console.** Policies can be listed but not created or edited in the UI. Use the API (`POST /v1/policies`, `PUT /v1/policies/:id`, `POST /v1/policies/:id/assign`). The accepted fields and defaults are defined in [`backend/src/domain/policy.ts`](backend/src/domain/policy.ts), and `GET /v1/policies/defaults` returns a starting spec.
- **Android agent app.** It has not been written yet. `agent/core` contains the shared verification logic the app will build on.
- **Object storage.** Blobs are stored on local disk (`LocalBlobStore`). Production deployments should implement `BlobStore` against S3-compatible storage with encryption at rest.

## Running locally

With Docker:

```bash
docker compose up --build
# Console: http://localhost:5173   API: http://localhost:8080
```

Without Docker (needs Node 22 and PostgreSQL 16):

```bash
cd backend
cp .env.example .env          # adjust DATABASE_URL
npm ci
npm run migrate
npm run dev                   # http://localhost:8080

cd ../console
npm ci
npm run dev                   # http://localhost:5173 (proxies /v1 to the backend)
```

Create an account from the console's sign-in page and set up MFA when prompted.

## Tests

```bash
cd backend && npm test        # needs a PostgreSQL database; see TEST_DATABASE_URL in test/helpers.ts
cd agent && ./gradlew :core:test
cd console && npm run build   # type-check + production build
```

CI (`.github/workflows/ci.yml`) runs all three on every push.

## Production checklist

- Set `NODE_ENV=production`, a strong `JWT_SECRET`, and an `https://` `PUBLIC_BASE_URL`.
- Generate the command signing key with `npm run keys:generate`, keep the private key in a secret manager, and build the agent with the printed public key.
- Configure `GOOGLE_SERVICE_ACCOUNT_JSON` and `FCM_PROJECT_ID` for push and Play Integrity.
- Set `AGENT_APK_URL` and `AGENT_APK_SIGNATURE_CHECKSUM` for QR provisioning.
- Provide S3-backed blob storage, and terminate TLS 1.2+ in front of the API.
- Before any Play Store release, complete the Play policy declarations described in spec §3.3.
