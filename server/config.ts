import type { AiProvider } from '../src/shared/types';

export interface ServerConfig {
  port: number;
  /** Signs session tokens. A deployment without its own secret is refused rather than guessed. */
  sessionSecret: string;
  sessionTtlMs: number;
  /** The provider credentials the hosted mode spends. They never leave this process. */
  provider: AiProvider;
  model: string;
  apiKey: string;
  /** Postgres connection string; omitted runs the in-memory store, for tests and local work. */
  databaseUrl?: string;
  /** Hosted jobs a single account may start per day before it must fall back to its own key. */
  dailyJobLimit: number;
  corsOrigins: string[];
  /** Fastify's logger option: on in production, off under test. */
  logging: boolean;
}

class ConfigError extends Error {}

function required(name: string, value: string | undefined): string {
  if (!value?.trim()) throw new ConfigError(`缺少环境变量 ${name}。`);
  return value.trim();
}

function number(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new ConfigError(`环境变量 ${name} 不是有效数字。`);
  return parsed;
}

const PROVIDERS = new Set<AiProvider>(['openai', 'deepseek', 'anthropic', 'custom']);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const provider = required('SIDENOTE_PROVIDER', env.SIDENOTE_PROVIDER) as AiProvider;
  if (!PROVIDERS.has(provider)) throw new ConfigError('SIDENOTE_PROVIDER 不是受支持的服务商。');
  const secret = required('SIDENOTE_SESSION_SECRET', env.SIDENOTE_SESSION_SECRET);
  // A short secret is guessable, and a leaked session token is a full account takeover.
  if (secret.length < 32) throw new ConfigError('SIDENOTE_SESSION_SECRET 至少需要 32 个字符。');
  return {
    port: number('PORT', env.PORT, 8787),
    sessionSecret: secret,
    sessionTtlMs:
      number('SIDENOTE_SESSION_TTL_HOURS', env.SIDENOTE_SESSION_TTL_HOURS, 720) * 3_600_000,
    provider,
    model: required('SIDENOTE_MODEL', env.SIDENOTE_MODEL),
    apiKey: required('SIDENOTE_API_KEY', env.SIDENOTE_API_KEY),
    databaseUrl: env.DATABASE_URL?.trim() || undefined,
    dailyJobLimit: number('SIDENOTE_DAILY_JOB_LIMIT', env.SIDENOTE_DAILY_JOB_LIMIT, 20),
    logging: env.SIDENOTE_LOG !== 'off',
    corsOrigins: (env.SIDENOTE_CORS_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  };
}
