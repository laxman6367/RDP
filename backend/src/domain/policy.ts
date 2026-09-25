import { z } from 'zod';

export const packageName = z
  .string()
  .max(255)
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/, 'must be an Android package name');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM (24h)');
const phone = z.string().regex(/^\+?[0-9*#]{3,20}$/, 'must be a phone number');

/** Days are 0=Sunday … 6=Saturday. An end before start wraps past midnight. */
export const scheduleSchema = z.strictObject({
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  start: hhmm,
  end: hhmm,
});

export const APP_CATEGORIES = ['social', 'games', 'video', 'messaging', 'browser', 'education', 'other'] as const;

/** Phase 1 — parental control policy (spec §4.2–§4.7). Every collection flag defaults to off (§3.4). */
export const familyPolicySchema = z.strictObject({
  apps: z
    .strictObject({
      reportUsage: z.boolean().default(true),
      blocked: z.array(packageName).max(500).default([]),
      timeLimits: z
        .array(z.strictObject({ package: packageName, dailyMinutes: z.number().int().min(0).max(1440) }))
        .max(500)
        .default([]),
      categoryLimits: z
        .array(z.strictObject({ category: z.enum(APP_CATEGORIES), dailyMinutes: z.number().int().min(0).max(1440) }))
        .default([]),
      // Bedtime / school hours: everything except `allowed` is suspended.
      downtime: z
        .array(z.strictObject({ name: z.string().min(1).max(64), schedule: scheduleSchema, allowed: z.array(packageName).default([]) }))
        .max(20)
        .default([]),
      requireInstallApproval: z.boolean().default(false),
    })
    .prefault({}),
  location: z
    .strictObject({
      enabled: z.boolean().default(false),
      intervalMinutes: z.number().int().min(5).max(1440).default(15),
      geofences: z
        .array(
          z.strictObject({
            id: z.string().min(1).max(64),
            name: z.string().min(1).max(64),
            lat: z.number().min(-90).max(90),
            lng: z.number().min(-180).max(180),
            radiusMeters: z.number().min(50).max(50_000),
          }),
        )
        .max(100)
        .default([]),
      sosEnabled: z.boolean().default(true),
    })
    .prefault({}),
  camera: z
    .strictObject({
      disabled: z.boolean().default(false),
      disabledSchedules: z.array(scheduleSchema).max(20).default([]),
      cameraDeniedPackages: z.array(packageName).max(500).default([]),
      microphoneDeniedPackages: z.array(packageName).max(500).default([]),
    })
    .prefault({}),
  comms: z
    .strictObject({
      sms: z.enum(['off', 'metadata', 'content']).default('off'),
      callLog: z.boolean().default(false),
      contacts: z.boolean().default(false),
      blockedNumbers: z.array(phone).max(1000).default([]),
      unknownNumberAlerts: z.boolean().default(false),
      keywordAlerts: z.boolean().default(false),
    })
    .prefault({}),
  social: z
    .strictObject({
      notificationSafetySignals: z.boolean().default(false),
      keywords: z.array(z.string().min(2).max(64)).max(200).default([]),
    })
    .prefault({}),
  kiosk: z
    .strictObject({
      studyMode: z
        .strictObject({ allowlist: z.array(packageName).max(50).default([]), schedules: z.array(scheduleSchema).max(20).default([]) })
        .prefault({}),
    })
    .prefault({}),
  antiTheft: z.strictObject({ enabled: z.boolean().default(false) }).prefault({}),
});

/** Phase 2 — enterprise policy: kiosk + wallpaper + anti-tamper only (spec §5). */
export const enterprisePolicySchema = z.strictObject({
  kiosk: z
    .strictObject({
      // When true the device runs permanently as a single-purpose (COSU) appliance.
      enforced: z.boolean().default(false),
      allowlist: z.array(packageName).max(50).default([]),
      message: z.string().max(280).optional(),
    })
    .prefault({}),
  wallpaper: z
    .strictObject({
      defaultWallpaperId: z.uuid().optional(),
      target: z.enum(['home', 'lock', 'both']).default('both'),
      lockChange: z.boolean().default(false),
    })
    .prefault({}),
  antiTamper: z
    .strictObject({
      disallowFactoryReset: z.boolean().default(true),
      disallowSafeBoot: z.boolean().default(true),
      disallowAddUser: z.boolean().default(true),
      // Google account IDs allowed to unlock after a factory reset (FRP).
      frpAdminAccountIds: z.array(z.string().min(1).max(64)).max(10).default([]),
    })
    .prefault({}),
});

export type FamilyPolicy = z.infer<typeof familyPolicySchema>;
export type EnterprisePolicy = z.infer<typeof enterprisePolicySchema>;
export type PolicySpec = FamilyPolicy | EnterprisePolicy;

export const policySchemaForPhase = (phase: 1 | 2) => (phase === 1 ? familyPolicySchema : enterprisePolicySchema);

export const defaultFamilyPolicy = (): FamilyPolicy => familyPolicySchema.parse({});
export const defaultEnterprisePolicy = (): EnterprisePolicy => enterprisePolicySchema.parse({});
