import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { aiRequestSchema } from '../src/background/validation';
import { DEFAULT_HOSTED_URL } from '../src/shared/hosted';
import type { AiRequest, Settings } from '../src/shared/types';
import { createEmbedder, EmbeddingError } from './ai/embeddings';
import { createGateway, type Gateway } from './ai/gateway';
import {
  createLibraryService,
  LibraryError,
  MAX_SEARCH_RESULTS,
  type LibraryService,
} from './ai/library';
import { createGoogleVerifier, GoogleAuthError, type GoogleVerifier } from './auth/google';
import { issueToken, readToken } from './auth/tokens';
import type { ServerConfig } from './config';
import { JobQueue } from './jobs/queue';
import type { Store } from './store/types';

// A 5-hour transcript is a few hundred kilobytes of JSON; the 1 MB default would reject it.
const BODY_LIMIT = 8 * 1024 * 1024;
const SIGN_IN_WINDOW_MS = 15 * 60_000;
/** A rolling deploy should finish the work a user already paid for, not drop it. */
const SHUTDOWN_DRAIN_MS = 90_000;
const SIGN_IN_ATTEMPTS = 10;

const googleSignIn = z.object({
  // A Google ID token; anything longer than this is not one.
  idToken: z.string().min(20).max(8192),
  nonce: z.string().min(1).max(500).optional(),
});
const jobBody = z.object({ request: aiRequestSchema });
const searchBody = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional(),
});
const DEFAULT_SEARCH_RESULTS = 8;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface AppOptions {
  config: ServerConfig;
  store: Store;
  /** Overridden in tests so no real provider is called. */
  gateway?: Gateway;
  /** Overridden in tests to supply a deterministic embedder; absent disables cross-video search. */
  library?: LibraryService;
  /** Overridden in tests so no real Google keys are fetched. */
  google?: GoogleVerifier;
}

export function createApp(options: AppOptions): FastifyInstance {
  const { config, store, gateway } = options;
  const app = Fastify({ bodyLimit: BODY_LIMIT, logger: config.logging });
  const settings: Settings = {
    // The server is the host; it never runs in hosted mode itself.
    mode: 'byok',
    serverUrl: DEFAULT_HOSTED_URL,
    sessionToken: '',
    accountEmail: '',
    provider: config.provider,
    baseUrl: config.baseUrl,
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
  const library =
    options.library ??
    (config.embedding
      ? createLibraryService(store, createEmbedder(config.embedding), (error) =>
          app.log.warn({ error }, '跨视频索引失败'),
        )
      : undefined);
  const queue = new JobQueue(ai);
  const google = options.google ?? createGoogleVerifier(config.googleClientId);
  const signInAttempts = new Map<string, { count: number; until: number }>();

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

  app.post('/v1/auth/google', async (request, reply) => {
    const parsed = googleSignIn.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '登录请求格式不正确。' });
    // Verification is signature work against a remote key set; a caller replaying junk at it
    // should not be able to spend that repeatedly.
    const attempt = signInAttempts.get(request.ip);
    if (attempt && attempt.until > Date.now() && attempt.count >= SIGN_IN_ATTEMPTS)
      return reply.code(429).send({ error: '尝试次数过多，请稍后再试。' });
    try {
      const identity = await google.verify(parsed.data.idToken, parsed.data.nonce);
      signInAttempts.delete(request.ip);
      const user = await store.users.fromGoogle(identity.subject, identity.email);
      return reply.send({
        token: issueToken(user.id, config.sessionSecret, config.sessionTtlMs),
        user: { id: user.id, email: user.email },
      });
    } catch (error) {
      if (!(error instanceof GoogleAuthError)) throw error;
      const next =
        attempt && attempt.until > Date.now()
          ? { count: attempt.count + 1, until: attempt.until }
          : { count: 1, until: Date.now() + SIGN_IN_WINDOW_MS };
      signInAttempts.set(request.ip, next);
      return reply.code(401).send({ error: error.message });
    }
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
      // The extension hides the cross-video surface rather than offering a button that 501s.
      features: { librarySearch: Boolean(library) },
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
    if (aiRequest.task !== 'translate')
      library?.schedule(aiRequest.video.id, aiRequest.transcript.cues);

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

  app.post('/v1/library/search', async (request, reply) => {
    const userId = await requireUser(request, reply);
    if (!userId) return undefined;
    if (!library) return reply.code(501).send({ error: '该服务端未开启跨视频知识库。' });
    const parsed = searchBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '搜索内容不能为空。' });
    // Only what this account has actually watched. The artifact cache is shared; a library is not.
    const videoIds = await store.library.list(userId);
    try {
      const matches = await library.search(
        videoIds,
        parsed.data.query,
        parsed.data.limit ?? DEFAULT_SEARCH_RESULTS,
      );
      const videos = new Map(
        await Promise.all(
          [...new Set(matches.map((match) => match.videoId))].map(
            async (id) => [id, await store.videos.get(id)] as const,
          ),
        ),
      );
      return reply.send({
        matches: matches.map((match) => ({
          ...match,
          title: videos.get(match.videoId)?.title ?? '',
          author: videos.get(match.videoId)?.author ?? '',
          url: videos.get(match.videoId)?.url ?? '',
        })),
      });
    } catch (error) {
      if (error instanceof LibraryError) return reply.code(400).send({ error: error.message });
      // An embedding failure is the provider's, not the caller's; its message is already
      // sanitised to a status code, so it is safe to pass through.
      if (error instanceof EmbeddingError) return reply.code(502).send({ error: error.message });
      throw error;
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
