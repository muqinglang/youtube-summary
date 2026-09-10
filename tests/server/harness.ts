import type { z } from 'zod';
import { createApp } from '../../server/app';
import type { Embedder } from '../../server/ai/embeddings';
import { createGateway } from '../../server/ai/gateway';
import { GoogleAuthError, type GoogleVerifier } from '../../server/auth/google';
import { createLibraryService, type LibraryService } from '../../server/ai/library';
import type { ServerConfig } from '../../server/config';
import { createMemoryStore } from '../../server/store/memory';
import type { Store } from '../../server/store/types';
import type { JsonClient } from '../../src/background/ai-service';
import { DEFAULT_HOSTED_URL } from '../../src/shared/hosted';
import type { Cue, Settings } from '../../src/shared/types';

export const CONFIG: ServerConfig = {
  port: 0,
  sessionSecret: 'test-secret-that-is-long-enough-for-the-check',
  sessionTtlMs: 3_600_000,
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4.1-mini',
  apiKey: 'server-side-key-never-sent-to-clients',
  googleClientId: 'test-client.apps.googleusercontent.com',
  dailyJobLimit: 3,
  logging: false,
  corsOrigins: ['chrome-extension://abcdefghijklmnopabcdefghijklmnop'],
};

const SETTINGS: Settings = {
  mode: 'byok',
  serverUrl: DEFAULT_HOSTED_URL,
  sessionToken: '',
  accountEmail: '',
  provider: 'openai',
  baseUrl: '',
  model: CONFIG.model,
  apiKey: CONFIG.apiKey,
  rememberKey: false,
  translationEngine: 'ai',
  autoTranslate: false,
  targetLanguage: '简体中文',
  prompt: '',
  temperature: 0.3,
};

/** Long cues force several batches, which is what makes the digest cache observable. */
export function longCues(count = 4, salt = ''): Cue[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `cue-${index}`,
    start: index * 10,
    end: index * 10 + 9,
    text: `${salt}${index} ${'a'.repeat(9000)}`,
  }));
}

export function transcriptFor(cues: Cue[], videoId = 'QLLuZbuTIRc') {
  return {
    videoId,
    language: 'en',
    source: 'youtube' as const,
    coverage: 'complete' as const,
    cues,
  };
}

export const VIDEO = {
  id: 'QLLuZbuTIRc',
  title: 'How to Think Clearly In The Era Of AI',
  author: 'Nick Saraev',
  url: 'https://www.youtube.com/watch?v=QLLuZbuTIRc',
  duration: 18_139,
  currentTime: 0,
  paused: true,
  tracks: [],
};

export interface StubEmbedder extends Embedder {
  /** Provider round trips. Skipping an already-indexed video must leave these untouched. */
  calls: { batches: number; texts: number };
}

/**
 * Hashed bag of words. Not a real embedding — it knows nothing about meaning — but it does put
 * passages that share vocabulary near each other, so a retrieval test asserts that the pipeline
 * ranks, rather than asserting that a fixture came back.
 */
export function lexicalEmbedder(dimensions = 512): StubEmbedder {
  const calls = { batches: 0, texts: 0 };
  return {
    calls,
    model: 'stub-lexical',
    dimensions,
    embed: async (texts) => {
      calls.batches += 1;
      calls.texts += texts.length;
      return texts.map((text) => {
        const vector = new Array<number>(dimensions).fill(0);
        for (const token of text.toLowerCase().match(/[a-z0-9]+|[一-鿿]/gu) ?? []) {
          let bucket = 0;
          for (const char of token) bucket = (bucket * 31 + char.codePointAt(0)!) % dimensions;
          vector[bucket]! += 1;
        }
        return vector;
      });
    },
  };
}

export interface CountingClient extends JsonClient {
  /** Provider calls actually made. A cache hit must leave this untouched. */
  calls: { digest: number; final: number };
}

/** Answers each schema with the smallest valid shape, so nothing hits a real provider. */
export function countingClient(): CountingClient {
  const calls = { digest: 0, final: 0 };
  const client: CountingClient = {
    calls,
    json: async <T>(system: string, data: unknown, schema: z.ZodType<T>) => {
      const source = data as { sourceCues?: Cue[]; sourceDigests?: unknown[] };
      const start = source.sourceCues?.[0]?.start ?? 0;
      if (system.includes('"notes"')) {
        calls.digest += 1;
        return schema.parse({ overview: 'Digest', notes: [{ start, text: 'Note' }] });
      }
      calls.final += 1;
      if (system.includes('table of contents'))
        return schema.parse({ sections: [{ title: 'Intro', start: 0 }] });
      if (system.includes('"questions"'))
        return schema.parse({
          questions: [{ question: '这段在讲什么？', start: 0, answer: '开场介绍。' }],
        });
      return schema.parse({
        title: 'Summary',
        overview: 'Overview',
        sections: [{ title: 'Chapter', start: 0, points: ['Point'] }],
        takeaways: ['Action'],
        mindmap: { title: 'Root', children: [{ title: 'Chapter', start: 0 }] },
      });
    },
  };
  return client;
}

/**
 * Stands in for Google. A test token is `subject|email`; anything else is rejected the way a
 * real bad token is, so the routes around it are exercised without any network or crypto.
 */
export function stubGoogle(): GoogleVerifier {
  return {
    verify: async (idToken, nonce) => {
      if (nonce !== undefined && !idToken.endsWith(`#${nonce}`))
        throw new GoogleAuthError('登录请求已失效，请重新登录。');
      const [subject, rest] = idToken.split('|');
      const email = rest?.split('#')[0];
      if (!subject || !email) throw new GoogleAuthError('登录凭证格式不正确。');
      return { subject, email: email.toLowerCase() };
    },
  };
}

/** The token a stubbed sign-in accepts for one address. */
export function googleToken(email: string, nonce?: string): string {
  return `sub-${email}|${email}${nonce ? `#${nonce}` : ''}`;
}

export interface HarnessOptions {
  config?: Partial<ServerConfig>;
  /** False builds the app without a library service, the shape of a deployment with no key. */
  librarySearch?: boolean;
}

export function createHarness({
  config: overrides = {},
  librarySearch = true,
}: HarnessOptions = {}) {
  const store: Store = createMemoryStore();
  const client = countingClient();
  const embedder = lexicalEmbedder();
  const config = { ...CONFIG, ...overrides };
  const library: LibraryService | undefined = librarySearch
    ? createLibraryService(store, embedder, (error) => {
        throw error;
      })
    : undefined;
  const app = createApp({
    config,
    store,
    gateway: createGateway(store, SETTINGS, client),
    google: stubGoogle(),
    ...(library ? { library } : {}),
  });
  return { app, store, client, config, embedder, library };
}

/** Signs in through the Google route and returns the session token. */
export async function register(
  app: ReturnType<typeof createHarness>['app'],
  email: string,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/google',
    payload: { idToken: googleToken(email) },
  });
  return response.json<{ token: string }>().token;
}

/** Starts a job and waits for it to leave the running state. */
export async function runJob(
  app: ReturnType<typeof createHarness>['app'],
  token: string,
  request: unknown,
): Promise<{ cached: boolean; status: number; result?: unknown; error?: string }> {
  const created = await app.inject({
    method: 'POST',
    url: '/v1/jobs',
    headers: { authorization: `Bearer ${token}` },
    payload: { request },
  });
  const body = created.json<{
    cached?: boolean;
    jobId?: string;
    result?: unknown;
    error?: string;
  }>();
  if (created.statusCode !== 202)
    return {
      cached: Boolean(body.cached),
      status: created.statusCode,
      result: body.result,
      error: body.error,
    };
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const view = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${body.jobId!}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const job = view.json<{ status: string; result?: unknown; error?: string }>();
    if (job.status !== 'running')
      return { cached: false, status: created.statusCode, result: job.result, error: job.error };
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('job did not finish');
}
