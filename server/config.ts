import { getProvider } from '../src/shared/providers';
import { validateBaseUrl } from '../src/shared/endpoint';
import type { AiProvider } from '../src/shared/types';

/**
 * The cross-video knowledge base needs a second provider: it is an embedding model, not a chat
 * model, and the two rarely come from the same account. Absent, the feature simply stays off.
 */
export interface EmbeddingConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Must equal what the model actually returns; it is baked into the vector column. */
  dimensions: number;
  /** Inputs per request. Providers cap this and the limits differ, so it is configurable. */
  batchSize: number;
}

export interface ServerConfig {
  port: number;
  /** Signs session tokens. A deployment without its own secret is refused rather than guessed. */
  sessionSecret: string;
  sessionTtlMs: number;
  /** The provider credentials the hosted mode spends. They never leave this process. */
  provider: AiProvider;
  /** Defaults to the provider's official endpoint; override only for a proxy or a mock. */
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Absent disables cross-video search; everything else runs unchanged. */
  embedding?: EmbeddingConfig;
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

/**
 * The value shipped in .env.example. It is 33 characters, so a length check waves it through,
 * and it is published in this repository — deploying with it lets anyone who has read the repo
 * forge a session token for any account. Copying the template and filling in only the keys you
 * were thinking about is the normal way to end up here, so it is refused by name.
 */
const PLACEHOLDER_SECRETS = new Set(['change-me-to-a-long-random-string']);

/** Alibaba Bailian, reachable from mainland China and OpenAI-compatible on this path. */
const DEFAULT_EMBEDDING_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-v3';
const DEFAULT_EMBEDDING_DIMENSIONS = 1024;
const DEFAULT_EMBEDDING_BATCH = 10;

/** Exported so a deployment can check its embedding provider without a full server config. */
export function loadEmbedding(env: NodeJS.ProcessEnv): EmbeddingConfig | undefined {
  const apiKey = env.SIDENOTE_EMBEDDING_API_KEY?.trim();
  if (!apiKey) return undefined;
  const dimensions = number(
    'SIDENOTE_EMBEDDING_DIMENSIONS',
    env.SIDENOTE_EMBEDDING_DIMENSIONS,
    DEFAULT_EMBEDDING_DIMENSIONS,
  );
  // The value reaches a CREATE TABLE as a literal, so it is checked here rather than trusted.
  if (!Number.isInteger(dimensions) || dimensions < 64 || dimensions > 4096)
    throw new ConfigError('SIDENOTE_EMBEDDING_DIMENSIONS 必须是 64 到 4096 之间的整数。');
  const batchSize = number(
    'SIDENOTE_EMBEDDING_BATCH',
    env.SIDENOTE_EMBEDDING_BATCH,
    DEFAULT_EMBEDDING_BATCH,
  );
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100)
    throw new ConfigError('SIDENOTE_EMBEDDING_BATCH 必须是 1 到 100 之间的整数。');
  return {
    baseUrl: validateBaseUrl(env.SIDENOTE_EMBEDDING_BASE_URL?.trim() || DEFAULT_EMBEDDING_BASE_URL),
    model: env.SIDENOTE_EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL,
    apiKey,
    dimensions,
    batchSize,
  };
}

function resolveBaseUrl(provider: AiProvider, override: string | undefined): string {
  if (override?.trim()) return validateBaseUrl(override);
  const official = getProvider(provider)?.baseUrl;
  if (!official) throw new ConfigError('自定义服务商必须同时设置 SIDENOTE_BASE_URL。');
  return official;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const provider = required('SIDENOTE_PROVIDER', env.SIDENOTE_PROVIDER) as AiProvider;
  if (!PROVIDERS.has(provider)) throw new ConfigError('SIDENOTE_PROVIDER 不是受支持的服务商。');
  const secret = required('SIDENOTE_SESSION_SECRET', env.SIDENOTE_SESSION_SECRET);
  // A short secret is guessable, and a leaked session token is a full account takeover.
  if (secret.length < 32) throw new ConfigError('SIDENOTE_SESSION_SECRET 至少需要 32 个字符。');
  if (PLACEHOLDER_SECRETS.has(secret.toLowerCase()))
    throw new ConfigError(
      'SIDENOTE_SESSION_SECRET 还是 .env.example 里的占位值，这个值是公开的。' +
        '请换成随机串，例如 openssl rand -base64 48。',
    );
  const embedding = loadEmbedding(env);
  return {
    port: number('PORT', env.PORT, 8787),
    sessionSecret: secret,
    sessionTtlMs:
      number('SIDENOTE_SESSION_TTL_HOURS', env.SIDENOTE_SESSION_TTL_HOURS, 720) * 3_600_000,
    provider,
    baseUrl: resolveBaseUrl(provider, env.SIDENOTE_BASE_URL),
    model: required('SIDENOTE_MODEL', env.SIDENOTE_MODEL),
    apiKey: required('SIDENOTE_API_KEY', env.SIDENOTE_API_KEY),
    ...(embedding ? { embedding } : {}),
    databaseUrl: env.DATABASE_URL?.trim() || undefined,
    dailyJobLimit: number('SIDENOTE_DAILY_JOB_LIMIT', env.SIDENOTE_DAILY_JOB_LIMIT, 20),
    logging: env.SIDENOTE_LOG !== 'off',
    corsOrigins: (env.SIDENOTE_CORS_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  };
}
