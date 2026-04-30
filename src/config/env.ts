import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().url(),
  DATABASE_POOL_URL: z.string().url().optional(),

  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  SUPABASE_JWT_SECRET: z.string().min(1),

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
