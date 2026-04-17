import { z } from 'zod';

// We use zod here despite using class-validator in controllers,
// because env validation needs to happen at boot with clear errors.
// Adding zod as a tiny dev-time dep is worth it.

// NOTE: if you prefer to avoid zod, swap for class-validator's plainToInstance
// pattern. Zod is imported only here.

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  API_BASE_URL: z.string().url(),
  WEB_ORIGIN: z.string().url(),

  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(20),

  REDIS_URL: z.string().url(),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be >= 32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be >= 32 chars'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  BCRYPT_COST: z.coerce.number().int().min(10).max(15).default(12),
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  LOGIN_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  // AES-256 key for encrypting integration credentials at rest.
  // Base64 of exactly 32 bytes.
  // Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  APP_ENCRYPTION_KEY: z.string().refine(
    (v) => {
      try {
        return Buffer.from(v, 'base64').length === 32;
      } catch {
        return false;
      }
    },
    { message: 'APP_ENCRYPTION_KEY must be base64 of exactly 32 bytes' },
  ),

  // Optional — preferred config path is /admin/integrations → metals.
  // Env is a bootstrap fallback so local dev + first deploys don't have a
  // chicken-and-egg problem before anyone's signed into the admin UI.
  METALS_API_KEY: z.string().optional().default(''),
  METALS_API_URL: z.string().url().default('https://api.metals.dev/v1/latest'),
  METALS_CACHE_TTL_SEC: z.coerce.number().int().positive().default(30),

  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: z.coerce.number().int().optional().default(587),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASS: z.string().optional().default(''),
  SMTP_FROM: z.string().optional().default('AGC CRM <noreply@example.com>'),

  TWILIO_ACCOUNT_SID: z.string().optional().default(''),
  TWILIO_AUTH_TOKEN: z.string().optional().default(''),
  TWILIO_FROM: z.string().optional().default(''),

  ENABLE_2FA: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  ENABLE_SIGNUP: z
    .string()
    .transform((v) => v !== 'false')
    .default('true'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validates the config object that NestJS's ConfigModule has already
 * merged from `.env` files + process.env. Do not read process.env here —
 * it won't yet reflect the .env contents at this callsite.
 */
export function loadEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    console.error('\nInvalid environment variables:');
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    throw new Error('Environment validation failed');
  }
  return parsed.data;
}
