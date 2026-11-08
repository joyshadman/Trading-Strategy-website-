import 'dotenv/config';
import { z } from 'zod';

const postgresUrl = z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection string');

const baseSchema = z.object({
  // Neon pooled URL (host has `-pooler`): normal Prisma queries.
  DATABASE_URL: postgresUrl,
  // Neon direct URL (no `-pooler`): the worker lock, LISTEN/NOTIFY, and migrations. The pooler
  // runs PgBouncer in transaction mode, which drops session state like these.
  // Optional for a plain local Postgres, where it falls back to DATABASE_URL.
  DATABASE_URL_UNPOOLED: postgresUrl.optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

const apiSchema = baseSchema.extend({
  // Localhost only, by design: there is no login, so the API must never be reachable from elsewhere.
  API_HOST: z
    .string()
    .default('127.0.0.1')
    .refine((host) => LOOPBACK_HOSTS.has(host), 'must be 127.0.0.1, localhost, or ::1 (localhost only, no login)'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  WEB_ORIGIN: z.url().default('http://localhost:5173'),
});

// OANDA settings are optional: without them forex feeds go to `error` and crypto still runs.
const workerSchema = baseSchema.extend({
  OANDA_API_TOKEN: z.string().min(1).optional(),
  OANDA_ACCOUNT_ID: z.string().min(1).optional(),
  OANDA_ENV: z.enum(['practice', 'live']).default('practice'),
});

export type ApiConfig = z.infer<typeof apiSchema>;
export type WorkerConfig = z.infer<typeof workerSchema>;

export type ConfigResult<T> = { ok: true; config: T } | { ok: false; problems: string[] };

function parse<T>(schema: z.ZodType<T>, env: NodeJS.ProcessEnv): ConfigResult<T> {
  const result = schema.safeParse(env);
  if (result.success) return { ok: true, config: result.data };
  return {
    ok: false,
    problems: result.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`),
  };
}

export const parseApiConfig = (env: NodeJS.ProcessEnv = process.env) => parse(apiSchema, env);
export const parseWorkerConfig = (env: NodeJS.ProcessEnv = process.env) => parse(workerSchema, env);

// Fail fast with a readable message instead of crashing later on a bad setting.
export function loadOrExit<T>(name: string, result: ConfigResult<T>): T {
  if (result.ok) return result.config;
  console.error(`[${name}] invalid configuration:\n  ${result.problems.join('\n  ')}`);
  console.error('See apps/server/.env.example for every setting.');
  process.exit(1);
}

// The connection for session level work (advisory lock, LISTEN). Never the pooled one.
export function directDatabaseUrl(config: { DATABASE_URL: string; DATABASE_URL_UNPOOLED?: string | undefined }): string {
  const url = config.DATABASE_URL_UNPOOLED ?? config.DATABASE_URL;
  if (/-pooler\./.test(url)) {
    throw new Error('DATABASE_URL_UNPOOLED must be the direct Neon URL (host without "-pooler")');
  }
  return url;
}
