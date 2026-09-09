import type { z } from 'zod';
import { createApp } from '../../server/app';
import { createGateway } from '../../server/ai/gateway';
import type { ServerConfig } from '../../server/config';
import { createMemoryStore } from '../../server/store/memory';
import type { Store } from '../../server/store/types';
import type { JsonClient } from '../../src/background/ai-service';
import type { Cue, Settings } from '../../src/shared/types';

export const CONFIG: ServerConfig = {
  port: 0,
  sessionSecret: 'test-secret-that-is-long-enough-for-the-check',
  sessionTtlMs: 3_600_000,
  provider: 'openai',
  model: 'gpt-4.1-mini',
  apiKey: 'server-side-key-never-sent-to-clients',
  dailyJobLimit: 3,
  logging: false,
  corsOrigins: ['chrome-extension://abcdefghijklmnopabcdefghijklmnop'],
};

const SETTINGS: Settings = {
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

export function createHarness(overrides: Partial<ServerConfig> = {}) {
  const store: Store = createMemoryStore();
  const client = countingClient();
  const config = { ...CONFIG, ...overrides };
  const app = createApp({
    config,
    store,
    gateway: createGateway(store, SETTINGS, client),
  });
  return { app, store, client, config };
}

export async function register(
  app: ReturnType<typeof createHarness>['app'],
  email: string,
  password = 'a-long-enough-password',
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password },
  });
  const body = response.json<{ token: string }>();
  return body.token;
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
