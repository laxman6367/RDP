<p align="center"><img src="assets/redcore-logo.png" alt="Redcore MDM" width="480"></p>

# Redcore — End-to-End Build Prompt & Product Specification

> **Document type:** Master build prompt + technical/product specification
> **Product:** Redcore — a consent-based Android Device Management (MDM) & Parental Control platform
> **Audience:** AI coding assistant / engineering team / product & compliance reviewers
> **Version:** 1.0

---

## 0. How to Use This File

This is a **build prompt**. Hand the whole document (or a phase-scoped slice of it) to an engineering team or an AI coding assistant. Every feature below is written as a buildable requirement with the Android APIs, data model, and compliance constraints attached.

**Non-negotiable rule for every implementer:** Redcore is a *transparent, consent-based* management tool. It is enrolled with the knowledge of the device holder (or their legal guardian / employer who owns the device). It is **not** covert spyware. Covert, hidden, or stalkerware behavior is out of scope and must never be implemented. This is both an ethical requirement and a hard Google Play policy requirement (see §3).

---

## 1. Product Vision

Redcore is a two-sided platform:

1. **Device Agent** — an Android app installed on the managed phone.
2. **Admin Console** — a web (and optional mobile) dashboard where an authorized administrator (a parent, an IT admin, an EMI financier, a government fleet manager) enrolls devices and applies policies.
3. **Backend** — command/control API, push channel, storage, auth, billing.

The product ships in two phases with deliberately different scope.

| Phase | Segment | Feature scope |
|-------|---------|---------------|
| **Phase 1** | Parental Control (family) | Full feature set: app control, location, camera/mic permission control, SMS/call/contact visibility, social-app controls, kiosk lock |
| **Phase 2** | Enterprise (EMI finance, Govt. officers, Enterprise companies) | Intentionally minimal: **Kiosk Lock** + **Wallpaper Change** only |

---

## 2. High-Level Architecture

```
┌──────────────────┐        HTTPS/REST + WebSocket        ┌──────────────────┐
│   Admin Console   │  <───────────────────────────────>  │     Backend       │
│  (Web / Mobile)   │                                      │  API + Auth + DB  │
└──────────────────┘                                      └─────────┬────────┘
                                                                     │ FCM push (command wake)
                                                                     ▼
                                                          ┌──────────────────┐
                                                          │  Device Agent     │
                                                          │  (Android app +   │
                                                          │   DPC / DO/PO)    │
                                                          └──────────────────┘
```

**Command model:** The console writes a *policy* or a *command*; the backend persists it and sends a silent FCM data message to wake the agent; the agent pulls the pending command queue over HTTPS, executes it, and reports back an ack + result. All state is reconciled (desired vs. reported), so a device that was offline catches up when it reconnects.

### Recommended stack

- **Device Agent:** Kotlin, Android 8.0+ (API 26+) target; `DevicePolicyManager`, Android Enterprise / Android Management API, `WorkManager`, Foreground Service, FCM.
- **Admin Console:** React (or Next.js) + TypeScript.
- **Backend:** Node.js/NestJS or Go; PostgreSQL; Redis (queues/cache); object storage (S3-compatible) for wallpapers/logs; FCM for push.
- **Auth:** OAuth2/OIDC, JWT access tokens, refresh tokens, MFA for admins.
- **Enterprise provisioning:** Android Management API (AMAPI) or a custom DPC with Device Owner via QR / zero-touch.

---

## 3. Compliance, Consent & Legal Framework (READ FIRST — applies to every feature)

These requirements are **part of the build**, not optional polish. An app that skips them will be rejected by Google Play and may be unlawful.

### 3.1 Enrollment & consent gate
- No feature activates until the device completes an explicit **enrollment** flow that identifies who owns/controls the device and records consent.
- **Parental (Phase 1):** the enrolling adult must attest legal guardianship of a **minor**, and the child-facing device shows a clear "This device is managed by a parent/guardian" state.
- **Enterprise (Phase 2):** device must be **company-owned** (EMI-financed, government-issued, or corporate) and enrolled as **Device Owner** at provisioning or point-of-sale.

### 3.2 Persistent transparency
- A **persistent, non-dismissible notification** and/or lock-screen/status indicator must always show that Redcore is active and managing the device. This is mandatory for any Play "monitoring" app.
- The managed user must be able to open an on-device screen listing exactly what is being monitored/controlled and who the administrator is.

### 3.3 Google Play policy specifics to design around
- **SMS & Call Log permissions** (`READ_SMS`, `READ_CALL_LOG`, etc.) are **restricted**. They require an approved use-case declaration in Play Console, and generally that the app be the default SMS/dialer handler *or* qualify under the "device monitoring for enterprise/parental" exception with the mandatory persistent notice. Plan for review and a fallback UX if not granted.
- **`QUERY_ALL_PACKAGES`** requires a policy declaration; prefer scoped queries where possible.
- **Accessibility Service** may NOT be used as a general surveillance backdoor. If used for on-screen content features, it must have a declared, user-facing purpose and pass Play review; expect scrutiny. Prefer official APIs (UsageStats, DevicePolicy) first.
- **Background location** requires the prominent-disclosure + separate runtime grant flow and a Play declaration.
- **Camera/microphone:** no silent capture. Any capture is disclosed, indicated (OS privacy indicators), and logged.

### 3.4 Data protection
- Data minimization: collect only what the active policy needs.
- Encryption in transit (TLS 1.2+) and at rest.
- Configurable retention windows + admin-initiated deletion + subject data export.
- Regional compliance hooks (GDPR/COPPA/DPDP-India as applicable). COPPA matters for the parental segment (children under 13).

### 3.5 Anti-abuse
- Detect and refuse enrollment patterns consistent with covert partner surveillance (e.g., adult-to-adult non-corporate).
- Rate-limit and audit-log every admin action; every command is attributable to an admin identity.

---

## 4. PHASE 1 — Parental Control (Full Feature Set)

Target: a parent/guardian managing a **minor's** Android phone. Device is enrolled as **Profile Owner** (work profile) or **Device Owner** (fully managed child device) depending on ownership.

### 4.1 Enrollment & pairing
**Goal:** securely bind a child device to a parent account.

- Parent creates account → creates a "Child" profile → generates a **pairing QR / 6-digit code**.
- Child device installs agent → scans QR → provisions DPC → grants required permissions via guided flow → registers with backend.
- Store: device identity, model, OS, enrollment timestamp, consent record, admin (parent) id.
- Show the child device a permanent "Managed by [Parent Name]" banner.

**APIs:** DevicePolicyManager provisioning, FCM token registration, Play Integrity for device attestation.

### 4.2 "Access all apps" — App inventory & control
**Interpretation:** view installed apps and manage which apps can run / for how long. (Not: read private in-app content covertly.)

Features:
- **App inventory:** list installed apps with usage stats.
  - `UsageStatsManager` for time-per-app; `PackageManager` (scoped) / `QUERY_ALL_PACKAGES` (declared) for inventory.
- **Block / allow apps:** hide or disable an app.
  - Device/Profile Owner: `DevicePolicyManager.setApplicationHidden()`, `setPackagesSuspended()`.
- **Time limits & schedules:** daily caps per app, bedtime/school-hours windows.
  - Enforced by agent foreground service + `setPackagesSuspended()` on limit reached.
- **App install control:** require parent approval for new installs; block by Play content rating.
- **Category filtering:** map apps to categories (games, social, etc.) for bulk rules.

Data reported to console: app list, per-app usage minutes, block state, last-used timestamp.

### 4.3 Location — real-time, history, geofencing
- **Real-time location:** on-demand fetch + configurable periodic reporting.
  - `FusedLocationProviderClient`; foreground service; `ACCESS_FINE_LOCATION` + `ACCESS_BACKGROUND_LOCATION` (with prominent disclosure).
- **Location history:** timeline of pings (retention-limited).
- **Geofences:** "home", "school", custom zones with enter/exit alerts to the parent.
  - `GeofencingClient` + `BroadcastReceiver`.
- **Low-battery / SOS location:** child can trigger a "share my location now" SOS.

Console UI: live map, history trail, geofence editor, alert feed.

### 4.4 Camera & Microphone — permission control (NOT covert capture)
**Interpretation for a compliant product:** manage *which apps* may use camera/mic, and support explicit anti-theft features — never silent surveillance of the child.

- **Permission governance:** view and revoke camera/mic permission for specific apps.
  - Device/Profile Owner: `setPermissionGrantState()`, `setCameraDisabled()` (global camera disable), user restrictions `DISALLOW_...`.
- **Global camera lock:** disable camera entirely during school hours if the parent chooses.
- **Anti-theft snapshot (optional, disclosed):** if the device is reported lost, capture a photo/location — with an on-screen/notification indication and an audit entry. OS privacy indicators remain on. **No silent/continuous audio or video recording is implemented.**

> Build guardrail: do not implement hidden microphone recording. If a stakeholder requests "listen to surroundings," treat it as out of scope; it is stalkerware and violates policy.

### 4.5 SMS, Call Logs & Contacts — visibility with consent + persistent notice
**Interpretation:** give the guardian visibility into a minor's messaging/calling for safety, under the mandatory persistent-notice regime, subject to Play approval.

- **SMS overview:** counts, senders, and (if approved) content of SMS; flag risky keywords/contacts.
  - `READ_SMS` (restricted — requires Play declaration + persistent notice, or default-handler model).
- **Call logs:** incoming/outgoing/missed, duration, number, contact-match.
  - `READ_CALL_LOG` (restricted, same constraints).
- **Contacts:** view saved contacts; allow-list/block-list for calls.
  - `READ_CONTACTS`; call blocking via `CallScreeningService` / `DevicePolicyManager` where available.
- **Safety alerts:** unknown-number alerts, keyword alerts (bullying/grooming/self-harm signals) surfaced to the parent.

> Build note: gate all of §4.5 behind a "restricted permission not granted" fallback so the app still functions (with these panels disabled) if Play denies the declaration.

### 4.6 Social media app controls (Instagram, WhatsApp, etc.)
**Interpretation:** manage access to and time spent in social apps; surface safety signals **without** breaking end-to-end encryption or scraping private content covertly.

- **Per-app access & time limits** for Instagram, WhatsApp, Snapchat, TikTok, etc. (reuses §4.2 engine, with a curated social-app catalog).
- **Schedule/bedtime blocking** of social apps.
- **Install gating:** require approval to install new social apps.
- **Notification-based safety signals (opt-in, disclosed):** using a declared `NotificationListenerService`, surface safety keyword alerts from notifications to the parent. Purpose is disclosed to the child; content is minimized; E2EE is never circumvented.
- **Screen-time reports** per social app with weekly trends.

> Do **not** attempt to read WhatsApp's encrypted database, inject into other apps, or bypass platform security. Those are prohibited and unstable. Stick to OS-sanctioned signals (usage stats, declared notification access, app-level blocking).

### 4.7 Kiosk Lock (Phase 1)
Lock the child device to a single app or a small allow-list (e.g., only educational apps, or a "study mode").

- **Single-app / multi-app kiosk** via **Lock Task Mode**:
  - `DevicePolicyManager.setLockTaskPackages()` + `Activity.startLockTask()`.
  - COSU-style restrictions: hide status bar, disable home/recents, block notifications, prevent exit.
- **Scheduled kiosk:** auto-enter "study mode" during set hours.
- **Parent unlock:** PIN or remote command from console to exit kiosk.

---

## 5. PHASE 2 — Enterprise (EMI, Government, Enterprise Companies)

**Scope is deliberately limited to exactly two features: Kiosk Lock and Wallpaper Change.** No location, no messaging, no social monitoring in Phase 2.

Device is enrolled as **Device Owner** (fully managed, company-owned) at point-of-sale (EMI) or during IT provisioning (govt/enterprise), typically via **QR provisioning**, **zero-touch enrollment**, or **Android Management API**.

### 5.1 Common enterprise enrollment
- Device Owner provisioning at first boot (factory-reset device, scan Redcore QR).
- Bind device to an **organization** and a specific **customer record** (loan account for EMI, employee/officer for govt/enterprise).
- Anti-tamper: `DISALLOW_FACTORY_RESET`, `DISALLOW_ADD_USER`, `DISALLOW_SAFE_BOOT`, keep-agent-installed, FRP (Factory Reset Protection) association so a wipe can't strand the device.

### 5.2 Feature 1 — Kiosk Lock (enterprise)
Two enterprise flavors of the same underlying Lock Task engine:

**A) EMI Mobiles — payment-linked lock**
- Normal state: phone works fully; agent shows periodic payment reminders as EMI due date approaches.
- **On default / missed payment:** backend issues a `LOCK` command → device enters a **full-screen kiosk "payment due" lock** (Lock Task Mode) that permits only: the payment screen, an emergency dialer, and a support contact. Everything else is blocked.
- **On payment received:** backend issues `UNLOCK` → kiosk released, full functionality restored.
- Grace-period, partial-lock (nag screen) and hard-lock tiers configurable per financier policy.
- **Compliance:** must follow local device-financing/consumer-lending regulations; retain emergency-call capability at all times; disclose the locking terms to the buyer at sale.

**B) Govt. Officers / Enterprise Companies — single-purpose lock**
- Lock the officer's/employee's device to an approved app or app-set (e.g., a field-data app, an inspection app, a POS app).
- IT admin defines the allow-list; device runs as a locked-down COSU appliance.
- Remote lock/unlock and remote "reset to kiosk" from the console.

**Shared kiosk implementation:**
- `setLockTaskPackages()` + `startLockTask()`, status-bar/home/recents disabled, custom lock UI, offline-persistent lock state (survives reboot — apply on `BOOT_COMPLETED`), reconciliation on reconnect.

### 5.3 Feature 2 — Wallpaper Change (enterprise)
Remotely set/replace the device wallpaper — for branding (EMI/enterprise), department identity (govt), or lock-screen instructions.

- Admin uploads image in console → backend stores + pushes URL → agent downloads → applies.
  - `WallpaperManager.setBitmap()` / `setStream()` for home & lock screen.
  - Device Owner can also **lock** the wallpaper so the user can't change it: user restriction `DISALLOW_SET_WALLPAPER`.
- Use cases: financier branding on EMI phones, "Property of [Dept.]" on government devices, "Contact IT: …" on enterprise devices, and a payment-reminder wallpaper as EMI due date nears.
- Support scheduled/rotating wallpapers and per-fleet defaults.

---

## 6. Admin Console (Web Dashboard)

Shared across both phases, feature-gated by segment.

- **Auth & roles:** Super Admin, Org Admin, Operator, Read-only; MFA required for admins.
- **Fleet view:** searchable/filterable device list (status, last-seen, policy, compliance).
- **Device detail:** live state, command history, policy assignment, audit log.
- **Policy builder:** create reusable policies (app rules, time limits, kiosk config, wallpaper) and assign to groups.
- **Command center:** send lock/unlock, wallpaper, locate (Phase 1), message.
- **Parental UX (Phase 1):** family-friendly views — map, screen-time reports, alert feed, approval requests.
- **EMI UX (Phase 2):** loan-account list, due dates, auto-lock rules, bulk lock/unlock, payment-webhook integration.
- **Audit & reporting:** every admin action logged with who/what/when; exportable.

---

## 7. Backend & Command Architecture

- **Reconciliation engine:** each device has `desiredState` (from policies/commands) and `reportedState`; agent syncs to converge.
- **Command queue:** durable, idempotent, acked; retries with backoff; expiry.
- **Push wake:** silent FCM data message triggers the agent to pull; never rely on push payload for the actual command (delivery isn't guaranteed).
- **Offline handling:** commands queue server-side; kiosk/lock state persists on-device across reboot and reconnect.
- **Webhooks (EMI):** payment gateway → backend → auto lock/unlock rule evaluation.
- **Rate limiting, idempotency keys, and full audit trail** on every mutating endpoint.

### 7.1 Core API surface (illustrative)
```
POST   /enroll                      # device enrollment / provisioning
POST   /devices/{id}/heartbeat      # agent check-in + reportedState
GET    /devices/{id}/commands       # pull pending commands
POST   /devices/{id}/commands/{c}/ack
POST   /devices/{id}/lock           # {mode: kiosk|payment|full, allowlist:[...]}
POST   /devices/{id}/unlock
POST   /devices/{id}/wallpaper      # {imageUrl, lockChange:bool}
POST   /devices/{id}/locate         # Phase 1 only
GET    /devices/{id}/apps           # Phase 1 inventory/usage
POST   /policies                    # create/assign policy
GET    /audit                       # admin action log
```

---

## 8. Data Model (core tables)

- **organizations** (id, type: family|emi|govt|enterprise, name, region)
- **admins** (id, org_id, role, email, mfa)
- **devices** (id, org_id, owner_ref, model, os, enroll_ts, consent_id, ownership: BYOD|company, do_po_mode, fcm_token, last_seen)
- **consents** (id, device_id, type, guardian/owner attestation, timestamp, doc_ref)
- **policies** (id, org_id, phase, json_spec)
- **device_policy** (device_id, policy_id, applied_ts)
- **commands** (id, device_id, type, payload, status, issued_by, ack_ts)
- **loans** (id, org_id, device_id, schedule, status) — EMI only
- **events/audit** (id, actor, action, target, ts, meta)
- **telemetry** (device_id, kind: usage|location|sms_meta|…, payload, ts) — Phase 1, retention-bound

Encrypt sensitive columns; partition/retire telemetry by retention window.

---

## 9. Android Permissions & Management Matrix

| Capability | Mechanism | Restriction / note |
|-----------|-----------|--------------------|
| App inventory | `QUERY_ALL_PACKAGES` / scoped queries | Play declaration required |
| App usage time | `UsageStatsManager` | Special access grant |
| Block/hide/suspend apps | Device/Profile Owner APIs | Needs DO/PO |
| Location (fg/bg) | `FusedLocationProvider`, geofencing | Prominent disclosure + Play declaration |
| Camera/mic governance | `setCameraDisabled`, `setPermissionGrantState` | DO/PO; no covert capture |
| SMS / call log | `READ_SMS`, `READ_CALL_LOG` | Restricted — Play approval + persistent notice |
| Contacts | `READ_CONTACTS` | Runtime grant |
| Social safety signals | declared `NotificationListenerService` | Purpose-declared; minimized |
| Kiosk / lock task | `setLockTaskPackages` + `startLockTask` | DO (or allow-listed PO) |
| Wallpaper | `WallpaperManager`, `DISALLOW_SET_WALLPAPER` | DO for lock-change |
| Anti-tamper (EMI/govt) | `DISALLOW_FACTORY_RESET`, FRP, `BOOT_COMPLETED` | Device Owner only |
| Persistent notice | Foreground service notification | **Mandatory** for monitoring |

---

## 10. Security Requirements

- TLS 1.2+ everywhere; certificate pinning on the agent.
- Play Integrity / device attestation at enrollment and periodically.
- Signed commands; agent verifies command origin.
- Tamper detection: alert if agent disabled, DO removed, or clock manipulated.
- Secrets in Android Keystore; no hardcoded keys.
- Principle of least privilege for admin roles; full audit logging.

---

## 11. Delivery Roadmap

**Phase 1 milestones**
1. Enrollment + consent + persistent notice + backend/command spine.
2. App inventory, usage, block/time-limits.
3. Location + geofencing.
4. Camera/mic permission governance + anti-theft snapshot.
5. SMS/call/contacts (behind Play-approval gate) + safety alerts.
6. Social app controls + notification safety signals.
7. Kiosk "study mode."
8. Parent console polish, reports, alerts.

**Phase 2 milestones**
1. Device Owner provisioning (QR/zero-touch/AMAPI) + anti-tamper + FRP.
2. Kiosk Lock engine (EMI payment-lock + govt/enterprise single-purpose).
3. Payment-webhook → auto lock/unlock (EMI).
4. Wallpaper change + lock, fleet branding.
5. Enterprise console (loan accounts, fleets, bulk ops, audit).

---

## 12. Testing & Acceptance

- Unit + instrumentation tests for policy enforcement and kiosk persistence (incl. reboot, offline, reconnect).
- OEM matrix testing (Samsung, Xiaomi/MIUI, Oppo/ColorOS, Vivo, stock) — aggressive battery managers and background limits are the #1 field failure; whitelist + foreground-service strategy required.
- Play policy pre-submission review of every restricted permission and disclosure screen.
- EMI lock/unlock end-to-end against a sandbox payment gateway.
- Security pen-test before launch.

**Acceptance gate for every feature:** works only after consented enrollment, is visible in the transparency screen, is attributable in the audit log, and degrades gracefully if a permission is denied.

---

## 13. Explicit Out-of-Scope (Do Not Build)

- Hidden/stealth mode, invisible icon, or any covert operation.
- Silent/continuous microphone or camera recording of the user.
- Reading other apps' encrypted content or bypassing E2EE.
- Enrolling adult, non-company-owned devices without the holder's consent.
- Any feature marketed or usable as partner/spouse surveillance ("stalkerware").

These are prohibited by Google Play policy and applicable law and must be refused if requested downstream.

---

*End of Redcore build prompt v1.0.*
