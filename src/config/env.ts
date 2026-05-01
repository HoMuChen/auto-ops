import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().url(),
  DATABASE_POOL_URL: z.string().url().optional(),

  /**
   * Supabase project URL — used to build the JWKS endpoint
   * (`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`) for asymmetric (ES256)
   * access-token verification. Required.
   */
  SUPABASE_URL: z.string().url(),
  /**
   * Browser-safe key. With CLI v2 this is `sb_publishable_…`; older projects
   * call it the `anon` key. Server doesn't need it — kept optional so legacy
   * `.env` files still parse.
   */
  SUPABASE_ANON_KEY: z.string().min(1).optional(),
  /**
   * Server-only Supabase key. With CLI v2 this is `sb_secret_…`; older
   * projects call it the `service_role` key. Optional — only needed if you
   * call Supabase admin endpoints from the API.
   */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  /**
   * Legacy HS256 shared secret. Optional. Only used if a token's header
   * alg=HS256 — modern Supabase tokens are ES256 and verified via JWKS.
   * Keep set in test environments where integration helpers mint HS256
   * tokens locally.
   */
  SUPABASE_JWT_SECRET: z.string().min(1).optional(),

  /**
   * OpenRouter is the only LLM gateway. Each agent's manifest selects its own
   * OpenRouter model slug; the user does not pick.
   */
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_REFERER: z.string().default('https://auto-ops.local'),

  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  WORKER_MAX_CONCURRENCY: z.coerce.number().int().positive().default(4),

  CLOUDFLARE_ACCOUNT_ID: z.string().optional(),
  CLOUDFLARE_IMAGES_TOKEN: z.string().optional(),

  LANGCHAIN_TRACING_V2: z.coerce.boolean().default(false),
  LANGCHAIN_API_KEY: z.string().optional(),
  LANGCHAIN_PROJECT: z.string().default('auto-ops'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const formatted = parsed.error.flatten().fieldErrors;
    console.error('Invalid environment configuration:', formatted);
    throw new Error('Environment validation failed. See logs above.');
  }
  cached = parsed.data;
  return cached;
}

export const env = new Proxy({} as Env, {
  get(_target, key: string) {
    return loadEnv()[key as keyof Env];
  },
});
