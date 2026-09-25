import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(8080),
  DATABASE_URL: z.string().default('postgres://redcore:redcore@localhost:5432/redcore'),
  // Public base URL of this API, used to build wallpaper and provisioning URLs.
  PUBLIC_BASE_URL: z.string().default('http://localhost:8080'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  JWT_SECRET: z.string().min(32).default('dev-only-insecure-jwt-secret-change-me-now'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().default(15 * 60),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().default(30),
  // Spec §6: MFA required for admins. Only disable for local development.
  REQUIRE_MFA: bool.default(true),
  ALLOW_SELF_SIGNUP: bool.default(true),
  // PEM-encoded ECDSA P-256 private key used to sign device commands (spec §10).
  // Generate with `npm run keys:generate`. Required outside development/test.
  COMMAND_SIGNING_KEY_PEM: z.string().optional(),
  COMMAND_SIGNING_KEY_FILE: z.string().optional(),
  COMMAND_TTL_HOURS: z.coerce.number().int().default(72),
  BLOB_DIR: z.string().default('var/blobs'),
  MAX_WALLPAPER_BYTES: z.coerce.number().int().default(8 * 1024 * 1024),
  // Google service account JSON (FCM push + Play Integrity). Optional.
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  FCM_PROJECT_ID: z.string().optional(),
  PLAY_INTEGRITY_PACKAGE_NAME: z.string().default('com.redcore.agent'),
  // Reject enrollment when Play Integrity fails (otherwise the verdict is recorded and an alert raised).
  INTEGRITY_ENFORCE: bool.default(false),
  // Device Owner QR provisioning (spec §5.1).
  AGENT_APK_URL: z.string().default('https://downloads.example.com/redcore-agent.apk'),
  AGENT_APK_SIGNATURE_CHECKSUM: z.string().default('REPLACE_WITH_URLSAFE_BASE64_SHA256_OF_SIGNING_CERT'),
  AGENT_ADMIN_COMPONENT: z.string().default('com.redcore.agent/.admin.RedcoreAdminReceiver'),
  JOBS_ENABLED: bool.default(true),
  JOB_INTERVAL_SECONDS: z.coerce.number().int().default(60),
  // A device that has not checked in for this long raises an "offline" tamper alert.
  OFFLINE_ALERT_HOURS: z.coerce.number().int().default(24),
  // Allowed device clock skew before a clock-manipulation alert (spec §10).
  MAX_CLOCK_SKEW_SECONDS: z.coerce.number().int().default(300),
  LOG_LEVEL: z.string().default('info'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const cfg = { ...schema.parse(env), ...overrides };
  if (cfg.NODE_ENV === 'production') {
    if (cfg.JWT_SECRET.startsWith('dev-only')) throw new Error('JWT_SECRET must be set in production');
    if (!cfg.COMMAND_SIGNING_KEY_PEM && !cfg.COMMAND_SIGNING_KEY_FILE) {
      throw new Error('COMMAND_SIGNING_KEY_PEM or COMMAND_SIGNING_KEY_FILE must be set in production');
    }
    if (!cfg.PUBLIC_BASE_URL.startsWith('https://')) throw new Error('PUBLIC_BASE_URL must be https in production');
  }
  return cfg;
}
