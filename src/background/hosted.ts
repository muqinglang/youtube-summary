import { z } from 'zod';
import { isAllowedHostedUrl } from '../shared/hosted';
import type { AiRequest, AiResult, JobProgress, LibraryMatch } from '../shared/types';
import { AiError, assertNotAborted } from './client';
import type { ProgressCallback } from './ai-service';

const REQUEST_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 1_000;
const MAX_RESPONSE_BYTES = 4_000_000;

const errorBody = z.object({ error: z.string().max(2000).optional() }).partial();
const accountSchema = z.object({
  token: z.string().min(1).max(4096),
  user: z.object({ id: z.string().max(200), email: z.string().max(320) }),
});
const meSchema = z.object({
  user: z.object({ id: z.string().max(200), email: z.string().max(320) }),
  usage: z.object({ jobsToday: z.number(), dailyJobLimit: z.number() }),
  library: z.array(z.string().max(200)).max(5000).optional(),
  // Absent on an older server, which is treated the same as off.
  features: z.object({ librarySearch: z.boolean() }).partial().optional(),
});
const searchSchema = z.object({
  matches: z
    .array(
      z.object({
        videoId: z.string().max(200),
        title: z.string().max(500),
        author: z.string().max(200),
        url: z.string().max(2000),
        start: z.number(),
        end: z.number(),
        text: z.string().max(8000),
        score: z.number(),
      }),
    )
    .max(50),
});
const progressSchema = z.object({
  completed: z.number(),
  total: z.number(),
  label: z.string().max(500),
});
const jobViewSchema = z.object({
  status: z.enum(['running', 'done', 'error', 'cancelled']),
  progress: progressSchema.optional(),
  result: z.unknown().optional(),
  error: z.string().max(2000).optional(),
});
const createdSchema = z.object({
  cached: z.boolean().optional(),
  jobId: z.string().max(200).optional(),
  result: z.unknown().optional(),
  error: z.string().max(2000).optional(),
  quotaExhausted: z.boolean().optional(),
});

export type Account = z.infer<typeof accountSchema>;
export type AccountStatus = z.infer<typeof meSchema>;

export interface HostedOptions {
  fetch?: typeof globalThis.fetch;
  permissionCheck?: (origin: string) => Promise<boolean>;
  pollIntervalMs?: number;
}

export class HostedClient {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly permissionCheck: (origin: string) => Promise<boolean>;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly serverUrl: string,
    private readonly token: string,
    options: HostedOptions = {},
  ) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.permissionCheck =
      options.permissionCheck ?? ((origin) => chrome.permissions.contains({ origins: [origin] }));
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    init: { method: 'GET' | 'POST'; body?: unknown; signal: AbortSignal; auth?: boolean },
  ): Promise<T> {
    assertNotAborted(init.signal);
    if (!isAllowedHostedUrl(this.serverUrl)) throw new AiError('托管服务地址无效。');
    const origin = new URL(this.serverUrl).origin;
    if (!(await this.permissionCheck(`${origin}/*`)))
      throw new AiError('尚未授权访问托管服务，请在设置中重新保存并允许访问。');
    if (init.auth && !this.token) throw new AiError('请先登录托管服务。');
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    init.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetcher(`${origin}${path}`, {
        method: init.method,
        headers: {
          'Content-Type': 'application/json',
          ...(init.auth ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: controller.signal,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
      });
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) throw new AiError('托管服务返回内容过大。');
      let raw: unknown;
      try {
        raw = text ? JSON.parse(text) : {};
      } catch {
        throw new AiError('托管服务返回了无效响应。');
      }
      if (!response.ok) {
        // The server writes messages meant for this user; anything else stays generic.
        const parsed = errorBody.safeParse(raw);
        if (response.status === 401)
          throw new AiError(parsed.data?.error ?? '登录状态已失效，请重新登录。');
        throw new AiError(parsed.data?.error ?? `托管服务请求失败（HTTP ${response.status}）。`);
      }
      const parsed = schema.safeParse(raw);
      if (!parsed.success) throw new AiError('托管服务返回的数据结构不正确。');
      return parsed.data;
    } catch (error) {
      if (init.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (error instanceof AiError) throw error;
      throw new AiError('无法连接托管服务，请检查网络和服务地址。');
    } finally {
      clearTimeout(timer);
      init.signal.removeEventListener('abort', onAbort);
    }
  }

  register(email: string, password: string, signal: AbortSignal): Promise<Account> {
    return this.request('/v1/auth/register', accountSchema, {
      method: 'POST',
      body: { email, password },
      signal,
    });
  }

  login(email: string, password: string, signal: AbortSignal): Promise<Account> {
    return this.request('/v1/auth/login', accountSchema, {
      method: 'POST',
      body: { email, password },
      signal,
    });
  }

  me(signal: AbortSignal): Promise<AccountStatus> {
    return this.request('/v1/me', meSchema, { method: 'GET', signal, auth: true });
  }

  /** Retrieval over the videos this account has watched. One embedding call, no queue. */
  async searchLibrary(query: string, limit: number, signal: AbortSignal): Promise<LibraryMatch[]> {
    const found = await this.request('/v1/library/search', searchSchema, {
      method: 'POST',
      body: { query, limit },
      signal,
      auth: true,
    });
    return found.matches;
  }

  /**
   * Hosted jobs are minutes long, so the result is collected by polling rather than by holding a
   * stream open: an MV3 service worker can be suspended, and a dropped stream would lose work
   * the server is still doing and the user has already been charged for.
   */
  async run(
    request: AiRequest,
    signal: AbortSignal,
    onProgress: ProgressCallback,
  ): Promise<AiResult> {
    const created = await this.request('/v1/jobs', createdSchema, {
      method: 'POST',
      body: { request },
      signal,
      auth: true,
    });
    if (created.result) return created.result as AiResult;
    if (!created.jobId) throw new AiError(created.error ?? '托管服务未返回任务编号。');
    const serverJobId = created.jobId;
    // Cancelling locally must also stop the server, or it keeps spending the user's quota.
    signal.addEventListener('abort', () => void this.cancel(serverJobId), { once: true });
    const jobId = encodeURIComponent(serverJobId);
    for (;;) {
      assertNotAborted(signal);
      await this.wait(signal);
      const view = await this.request(`/v1/jobs/${jobId}`, jobViewSchema, {
        method: 'GET',
        signal,
        auth: true,
      });
      if (view.progress) onProgress(view.progress satisfies Omit<JobProgress, 'jobId'>);
      if (view.status === 'done' && view.result) return view.result as AiResult;
      if (view.status === 'done') throw new AiError('托管服务未返回结果，请重试。');
      if (view.status !== 'running') throw new AiError(view.error ?? '托管任务未完成。');
    }
  }

  /** Best effort: the server also drops the job when its own deadline passes. */
  async cancel(jobId: string): Promise<void> {
    const controller = new AbortController();
    await this.request(`/v1/jobs/${encodeURIComponent(jobId)}/cancel`, z.object({}).passthrough(), {
      method: 'POST',
      signal: controller.signal,
      auth: true,
    }).catch(() => undefined);
  }

  private wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException('Cancelled', 'AbortError'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, this.pollIntervalMs);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
