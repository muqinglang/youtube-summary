import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { aiRequestSchema } from '../src/background/validation';
import type { AiRequest, Settings } from '../src/shared/types';
import { createGateway, type Gateway } from './ai/gateway';
import { hashPassword, verifyPassword } from './auth/passwords';
import { issueToken, readToken } from './auth/tokens';
import type { ServerConfig } from './config';
import { JobQueue } from './jobs/queue';
import type { Store } from './store/types';

// A 5-hour transcript is a few hundred kilobytes of JSON; the 1 MB default would reject it.
const BODY_LIMIT = 8 * 1024 * 1024;
const LOGIN_WINDOW_MS = 15 * 60_000;
/** A rolling deploy should finish the work a user already paid for, not drop it. */
const SHUTDOWN_DRAIN_MS = 90_000;
const LOGIN_ATTEMPTS = 10;

const credentials = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  // Long enough to resist guessing, and capped so scrypt cannot be turned into a CPU attack.
  password: z.string().min(10).max(200),
});
const jobBody = z.object({ request: aiRequestSchema });

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface AppOptions {
  config: ServerConfig;
  store: Store;
  /** Overridden in tests so no real provider is called. */
  gateway?: Gateway;
}

export function createApp({ config, store, gateway }: AppOptions): FastifyInstance {
  const app = Fastify({ bodyLimit: BODY_LIMIT, logger: config.logging });
  const settings: Settings = {
    provider: config.provider,
    baseUrl: '',
    model: config.model,
    apiKey: config.apiKey,
    rememberKey: false,
    translationEngine: 'ai',
    autoTranslate: false,
    targetLanguage: '简体中文',
    prompt: '',
    temperature: 0.3,
  };
  const ai = gateway ?? createGateway(store, settings);
  const queue = new JobQueue(ai);
  const loginAttempts = new Map<string, { count: number; until: number }>();

  app.addHook('onClose', async () => {
    const abandoned = await queue.drain(SHUTDOWN_DRAIN_MS);
    if (abandoned) app.log.warn({ abandoned }, '关闭时仍有任务未完成，已中断。');
  });

  const allowed = new Set(config.corsOrigins);
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && allowed.has(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (request.method === 'OPTIONS') await reply.code(204).send();
  });

  function authenticate(request: FastifyRequest): string | undefined {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) return undefined;
    return readToken(header.slice(7), config.sessionSecret);
  }

  async function requireUser(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<string | undefined> {
    const userId = authenticate(request);
    if (!userId) {
      await reply.code(401).send({ error: '请先登录。' });
      return undefined;
    }
    if (!(await store.users.byId(userId))) {
      await reply.code(401).send({ error: '登录状态已失效，请重新登录。' });
      return undefined;
    }
    return userId;
  }

  // Liveness: the process is up. Kept dependency-free so a database blip does not trigger
  // a restart loop that cannot possibly help.
  app.get('/health', async () => ({ ok: true }));
  // Readiness: safe to send traffic to. A load balancer must not route here until the store
  // answers, or the first request after a deploy fails for the user instead of the probe.
  app.get('/ready', async (_request, reply) => {
    try {
      await store.ping();
      return reply.send({ ready: true });
    } catch {
      return reply.code(503).send({ ready: false });
    }
  });

  app.post('/v1/auth/register', async (request, reply) => {
    const parsed = credentials.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: '邮箱或密码格式不正确，密码至少 10 位。' });
    const { email, password } = parsed.data;
    if (await store.users.byEmail(email))
      return reply.code(409).send({ error: '该邮箱已注册，请直接登录。' });
    const user = await store.users.create(email, await hashPassword(password));
    return reply.code(201).send({
      token: issueToken(user.id, config.sessionSecret, config.sessionTtlMs),
      user: { id: user.id, email: user.email },
    });
  });

  app.post('/v1/auth/login', async (request, reply) => {
    const parsed = credentials.safeParse(request.body);
    // The same message for a bad address and a bad password: no account enumeration.
    const rejection = { error: '邮箱或密码不正确。' };
    if (!parsed.success) return reply.code(401).send(rejection);
    const { email, password } = parsed.data;
    const throttleKey = `${request.ip}::${email}`;
    const attempt = loginAttempts.get(throttleKey);
    if (attempt && attempt.until > Date.now() && attempt.count >= LOGIN_ATTEMPTS)
      return reply.code(429).send({ error: '尝试次数过多，请稍后再试。' });
    const user = await store.users.byEmail(email);
    const ok = user ? await verifyPassword(password, user.passwordHash) : false;
    if (!ok || !user) {
      const next =
        attempt && attempt.until > Date.now()
          ? { count: attempt.count + 1, until: attempt.until }
          : { count: 1, until: Date.now() + LOGIN_WINDOW_MS };
      loginAttempts.set(throttleKey, next);
      return reply.code(401).send(rejection);
    }
    loginAttempts.delete(throttleKey);
    return reply.send({
      token: issueToken(user.id, config.sessionSecret, config.sessionTtlMs),
      user: { id: user.id, email: user.email },
    });
  });

  app.get('/v1/me', async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (!userId) return undefined;
    const user = await store.users.byId(userId);
    const used = await store.usage.jobsToday(userId, today());
    return reply.send({
      user: { id: user!.id, email: user!.email },
      usage: { jobsToday: used, dailyJobLimit: config.dailyJobLimit },
      library: await store.library.list(userId),
    });
  });

  app.post('/v1/jobs', async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (!userId) return undefined;
    const parsed = jobBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '请求格式不正确。' });
    const aiRequest = parsed.data.request as AiRequest;
    if (aiRequest.task !== 'translate') {
      await store.videos.upsert({
        videoId: aiRequest.video.id,
        title: aiRequest.video.title,
        author: aiRequest.video.author,
        url: aiRequest.video.url,
        duration: aiRequest.video.duration,
      });
      await store.library.add(userId, aiRequest.video.id);
    }
    await store.transcripts.put({
      videoId: aiRequest.transcript.videoId,
      trackId: aiRequest.transcript.language,
      language: aiRequest.transcript.language,
      source: aiRequest.transcript.source,
      coverage: aiRequest.transcript.coverage,
      cues: aiRequest.transcript.cues,
    });

    // A cached artifact costs nothing, so it is served before the quota is even consulted, and
    // without entering the queue: this is the common path once anyone has processed the video.
    const cached = await ai.peek(aiRequest);
    if (cached) return reply.send({ cached: true, result: cached });

    const used = await store.usage.jobsToday(userId, today());
    if (used >= config.dailyJobLimit)
      return reply.code(402).send({
        error: '今日额度已用完，可在设置中改用自己的 API Key 继续。',
        quotaExhausted: true,
      });
    await store.usage.recordJob(userId, today());
    try {
      const job = queue.start(userId, aiRequest);
      return reply.code(202).send({ cached: false, jobId: job.id });
    } catch (error) {
      return reply.code(429).send({ error: error instanceof Error ? error.message : '任务过多。' });
    }
  });

  app.get<{ Params: { id: string } }>('/v1/jobs/:id', async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (!userId) return undefined;
    const view = queue.view(request.params.id, userId);
    if (!view) return reply.code(404).send({ error: '任务不存在或已过期。' });
    return reply.send(view);
  });

  app.post<{ Params: { id: string } }>('/v1/jobs/:id/cancel', async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (!userId) return undefined;
    if (!queue.cancel(request.params.id, userId))
      return reply.code(404).send({ error: '任务不存在或已结束。' });
    return reply.send({ cancelled: true });
  });

  app.get<{ Params: { id: string } }>('/v1/jobs/:id/events', async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (!userId) return undefined;
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: unknown) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    const unsubscribe = queue.subscribe(request.params.id, userId, (event) => {
      send(event);
      if (event.type !== 'progress') reply.raw.end();
    });
    if (!unsubscribe) {
      send({ type: 'error', error: '任务不存在或已过期。' });
      reply.raw.end();
      return reply;
    }
    request.raw.on('close', unsubscribe);
    return reply;
  });

  return app;
}
