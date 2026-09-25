# Redcore Phase 1 (Parental Control) — Remaining Work Requirements

> **Purpose:** a developer hand-off describing the two Phase 1 pieces not yet built — the
> console policy editor and the Android agent's parental features — and how they must behave.
> **Read alongside:** [`SPEC.md`](SPEC.md) (§3 compliance, §4 features, §9 permissions),
> [`../README.md`](../README.md), and [`../backend/src/domain/policy.ts`](../backend/src/domain/policy.ts).

## 0. Non-negotiable rules (apply to everything below)

These come from SPEC §3 and §13 and are already enforced by the backend. Anything built here must
keep them true:

1. **Consent first.** No parental feature does anything until the device is enrolled through the
   consent flow: the guardian's attestation is recorded, and the device holder acknowledges the
   on-device notice. The backend already refuses enrollment for anyone 18+ and requires COPPA
   consent under 13.
2. **Always visible.** A persistent, non-dismissible notification must show that Redcore is active
   whenever any monitoring or control is in effect. The child must be able to open a screen listing
   exactly what is managed and who the guardian is.
3. **Official APIs only.** Use `DevicePolicyManager`, `UsageStatsManager`, `FusedLocationProvider`,
   `WallpaperManager`, and other documented Android APIs. Do **not** read other apps' private data,
   bypass encryption, use accessibility services as a data backdoor, or capture audio/video silently.
4. **Data minimization.** Only collect what the active policy enables. The backend rejects telemetry
   the policy did not turn on and strips SMS bodies unless content visibility is explicitly on.
5. **Degrade gracefully.** If a permission is denied, the related feature is disabled and reported as
   such; the app keeps working otherwise.

The acceptance gate for every feature (SPEC §12): works only after consented enrollment, appears on
the transparency screen, is attributable in the audit log, and degrades gracefully when a permission
is denied.

---

## Part A — Console policy editor (web)

**Status:** the Policies page currently only lists policies. Creating and editing them must be added.

**Backend is ready.** Use these existing endpoints (see `console/src/api.ts` for the client):

| Action | Call |
|--------|------|
| Get the empty default spec for this org's phase | `GET /v1/policies/defaults` |
| Create | `POST /v1/policies` `{ name, spec }` |
| Read | `GET /v1/policies/:id` |
| Update (bumps version, re-applies to assigned devices) | `PUT /v1/policies/:id` `{ name?, spec }` |
| Assign to devices | `POST /v1/policies/:id/assign` `{ deviceIds: [...] }` |
| Delete (only when unassigned) | `DELETE /v1/policies/:id` |

**Spec shape** is defined and validated by `familyPolicySchema` in
`backend/src/domain/policy.ts`. The editor must produce exactly that shape; the server rejects
unknown keys and out-of-range values and returns field-level errors (render them with the existing
`ErrorBanner`). The editable groups:

- **apps**: `reportUsage` (bool), `blocked` (package list), `timeLimits`
  (`{package, dailyMinutes}`), `categoryLimits` (`{category, dailyMinutes}`), `downtime`
  (`{name, schedule, allowed[]}`), `requireInstallApproval` (bool).
- **location**: `enabled`, `intervalMinutes` (5–1440), `geofences`
  (`{id, name, lat, lng, radiusMeters}`), `sosEnabled`.
- **camera**: `disabled`, `disabledSchedules[]`, `cameraDeniedPackages[]`, `microphoneDeniedPackages[]`.
- **comms**: `sms` (`off`|`metadata`|`content`), `callLog`, `contacts`, `blockedNumbers[]`,
  `unknownNumberAlerts`, `keywordAlerts`.
- **social**: `notificationSafetySignals`, `keywords[]`.
- **kiosk.studyMode**: `allowlist[]`, `schedules[]`.
- **antiTheft**: `enabled`.

A `schedule` is `{ days: number[] (0=Sun…6=Sat), start: "HH:MM", end: "HH:MM" }`; an end before start
means the window wraps past midnight.

**UX requirements**
- Everything defaults to **off**. Turning a data-collecting option on should show a one-line note of
  what the child will see about it, matching the transparency wording.
- A live preview of the transparency report helps (`GET /v1/devices/:id/transparency` shows the
  device-level version; the same builder drives it).
- Validation errors map to fields. Saving returns the new version and how many devices were updated.
- An "Advanced (JSON)" view that edits the raw spec is acceptable as a fallback.

**Acceptance:** a guardian can create a policy, assign it to their child's device, edit it, and see
the device's desired version increase and the transparency screen change accordingly.

---

## Part B — Android agent, parental features

**Status:** only `agent/core` exists (signed-state verification and the command guard). The Android
`app` module and all on-device behavior remain to be built. `agent/core` already provides the models,
`EnvelopeVerifier` (ECDSA P-256, tested against the backend signer) and `CommandGuard`
(rejects bad-signature, wrong-device, expired, replayed and stale messages).

### B0. Foundation (build before any feature)

Enrollment, the check-in loop and the transparency surfaces are prerequisites — they are what make
the product consent-based and compliant. Build these first.

- **Provisioning & pairing (SPEC §4.1).** Support a Profile-Owner work profile on an existing phone
  and a fully-managed Device-Owner setup on a new/reset phone. The pairing/provisioning QR payloads
  are produced by `POST /v1/enrollment-tokens`.
- **Consent acknowledgement.** Show the notice returned by `GET /v1/enroll/:code`. The child/holder
  must tap to acknowledge before enrollment completes; send `holderAcknowledged: true` plus the DPC
  mode to `POST /v1/enroll`. Store the returned device credential in the Android Keystore.
- **Persistent notice (SPEC §3.2).** A foreground service with a non-dismissible notification stating
  the device is managed by Redcore, plus an in-app transparency screen rendering
  `GET /v1/devices/:id/transparency`.
- **Sync loop (SPEC §7).** On FCM data message, on a `WorkManager` interval, and on `BOOT_COMPLETED`:
  `POST /v1/devices/:id/heartbeat` with the applied version and reported state (permission grants,
  DPC status, battery, agent/OS version); if the response carries a newer signed state, verify it via
  `CommandGuard.checkState`, apply it, then report the new version. Also
  `GET /v1/devices/:id/commands`, execute each after `CommandGuard.checkCommand`, and
  `POST …/ack`. Persist the applied state and executed-command ids so a reboot re-applies without
  re-running one-shots.
- **Tamper signals (SPEC §10).** Report to the backend if the device admin is disabled or Device
  Owner is removed (the backend also detects clock skew and going offline).
- **Retire.** When the signed state has `released: true`, remove all restrictions and stop the
  service; the backend revokes the credential on the next ack.

### B1. Apps & screen time (SPEC §4.2)

- **Inventory & usage:** report installed apps and per-app usage via `PackageManager` and
  `UsageStatsManager` when `apps.reportUsage` is on. Send as `app_inventory` / `app_usage` telemetry.
- **Block / limit:** apply `apps.blocked`, `timeLimits`, `categoryLimits` and `downtime` windows using
  Device/Profile Owner controls (`setApplicationHidden` / `setPackagesSuspended`). When a daily limit
  is reached, suspend the app until the next day and raise a `limit_reached` alert.
- **Install approval:** when `requireInstallApproval` is on, hold new installs and raise an
  `install_request` alert for the guardian to approve.

### B2. Location (SPEC §4.3)

- Report location on the policy interval and on a `LOCATE` command, using `FusedLocationProvider`.
  Requires the prominent-disclosure flow and the background-location runtime grant.
- Evaluate `geofences` and raise `geofence_enter` / `geofence_exit` alerts.
- If `sosEnabled`, let the child share location on demand (`sos` alert).

### B3. Camera & microphone governance (SPEC §4.4)

- Apply `camera.disabled` (global, `setCameraDisabled`) and `disabledSchedules`.
- Remove camera/mic permission from `cameraDeniedPackages` / `microphoneDeniedPackages` via
  `setPermissionGrantState`. **No capture of audio or video by Redcore.**
- **Lost-device (anti-theft):** on an `ANTI_THEFT_SNAPSHOT` command, only when `antiTheft.enabled`,
  show an on-screen notice, capture one photo and the location with OS privacy indicators visible,
  upload it, and let the ack record it. Never silent or continuous.

### B4. Messages, calls, contacts (SPEC §4.5)

- Behind the restricted-permission gate: report `sms` (metadata, or content only if the policy says
  `content`), `call_log`, and `contacts` telemetry. The backend already drops SMS bodies unless
  content is enabled.
- Apply `blockedNumbers` (call blocking / `CallScreeningService`).
- Raise `unknown_number` and `keyword` alerts when enabled. Keyword matching runs on-device; only the
  matched alert is sent, never the surrounding content.
- If `READ_SMS` / `READ_CALL_LOG` are not granted, disable these panels and report the permission
  state; the app must keep working.

### B5. Social app safety signals (SPEC §4.6)

- Reuse the app time-limit/block engine with the social-app catalog.
- If `social.notificationSafetySignals` is on, use a **declared** `NotificationListenerService` to
  match `social.keywords` on-device and raise `keyword` alerts. Never read or decrypt private chats;
  never circumvent end-to-end encryption. The purpose must be disclosed to the child.

### B6. Study mode (SPEC §4.7)

- When the signed state's `kiosk.mode` is `study` (or a `kiosk.studyMode` schedule is active), restrict
  the device to the allow-listed apps using Lock Task Mode. Exit on schedule end or on an unlock.
- Scheduled entry/exit is computed on-device from the policy schedule; an admin override in the signed
  state takes precedence. (The shared lock UI is common with Phase 2 and is tracked separately.)

---

## Part C — Cross-cutting / launch (SPEC §3.3, §3.4, §10, §12)

- **Play Console declarations** for `QUERY_ALL_PACKAGES`, background location, and the restricted
  `READ_SMS` / `READ_CALL_LOG` use cases, each with the mandatory persistent-notice disclosure. Have
  a working fallback UX if a restricted permission is denied.
- **OEM matrix testing** (Samsung/One UI, Xiaomi/MIUI, Oppo/ColorOS, Vivo, stock) — aggressive battery
  managers are the top field-failure cause; use the foreground service + battery-exemption strategy.
- **Storage & security:** S3-compatible blob storage with encryption at rest (implement `BlobStore`),
  TLS 1.2+ with certificate pinning in the agent, and a penetration test before launch.
- **Data rights:** retention purge, export and deletion already exist server-side; surface them in the
  console (export/delete already wired on the device page).

---

## Interfaces summary (already built, do not re-implement)

- Policy schema & defaults: `backend/src/domain/policy.ts`, `GET /v1/policies/defaults`.
- Desired-state shape the agent receives: `backend/src/domain/desired-state.ts`
  (`StateEnvelope` / `CommandEnvelope` mirrored in `agent/core/.../Models.kt`).
- Telemetry kinds and what each requires: `backend/src/domain/telemetry-rules.ts`.
- Alert kinds: same file. Transparency wording: `backend/src/domain/transparency.ts`.
- Agent endpoints: heartbeat, commands, ack, attachment upload, telemetry, alerts, wallpaper download —
  see `backend/src/http/routes/agent.ts`.
- Signature verification & anti-replay for the agent: `agent/core`.
