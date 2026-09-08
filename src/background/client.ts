import { z } from 'zod';
import type { Settings } from '../shared/types';
import { getOriginPattern, validateBaseUrl } from '../shared/endpoint';
import { getProvider } from '../shared/providers';

const MAX_RESPONSE_BYTES = 2_000_000;
/** Rate limits and server errors: keep the existing bounded, backed-off budget. */
const HTTP_RETRIES = 2;
/** Malformed or truncated model output: retry with corrective guidance instead of failing. */
const REPAIR_RETRIES = 2;
const TIMEOUT_RETRIES = 1;
const REPAIR_DELAY_MS = 250;
const MAX_ROUNDS = HTTP_RETRIES + REPAIR_RETRIES + TIMEOUT_RETRIES + 1;

const envelope = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable().optional(),
        message: z.object({ content: z.string().max(MAX_RESPONSE_BYTES) }),
      }),
    )
    .min(1),
});
const anthropicEnvelope = z.object({
  content: z
    .array(
      z.object({ type: z.string().max(100), text: z.string().max(MAX_RESPONSE_BYTES).optional() }),
    )
    .min(1)
    .max(100),
  stop_reason: z.string().nullable(),
  stop_details: z.object({ type: z.string() }).nullable().optional(),
});

const TRUNCATED_HINT =
  'Your previous reply was cut off before the JSON object ended. Return a SHORTER but COMPLETE object: fewer list items and briefer text in every field.';
const INVALID_JSON_HINT =
  'Your previous reply was not parseable JSON. Return exactly one complete JSON object, with no commentary, explanation or markdown fences.';

export class AiError extends Error {
  /** Structural, secret-free context (schema paths) used for diagnostics only. */
  readonly detail?: string;
  constructor(message: string, detail?: string) {
    super(message);
    this.name = 'AiError';
    this.detail = detail;
  }
}

/** A malformed model reply. Worth another attempt, with the problem fed back to the model. */
class RepairableError extends AiError {
  readonly hint: string;
  constructor(message: string, hint: string, detail?: string) {
    super(message, detail);
    this.hint = hint;
  }
}

/** Zod paths only: enough to fix a prompt, never transcript text or credentials. */
function schemaPaths(error: z.ZodError): string {
  const paths = error.issues
    .slice(0, 6)
    .map((issue) => (issue.path.length ? issue.path.join('.') : '(root)'));
  return [...new Set(paths)].join(', ');
}
function schemaHint(error: z.ZodError): string {
  const problems = error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`);
  return `Your previous reply did not match the required JSON schema. Fix exactly these problems and return the COMPLETE corrected JSON object only: ${problems.join('; ')}`;
}

function responseContent(raw: unknown, anthropic: boolean): string {
  if (anthropic) {
    const parsed = anthropicEnvelope.safeParse(raw);
    if (!parsed.success) throw new AiError('Claude 服务返回了无效的 Messages 响应。');
    if (parsed.data.stop_reason === 'max_tokens')
      throw new RepairableError('AI 输出被截断，请缩短总结要求后重试。', TRUNCATED_HINT);
    if (parsed.data.stop_reason === 'refusal' || parsed.data.stop_details?.type === 'refusal')
      throw new AiError('Claude 未完成此请求，请调整问题或总结要求后重试。');
    if (!['end_turn', 'stop_sequence'].includes(parsed.data.stop_reason ?? ''))
      throw new AiError('Claude 尚未返回完整结果，未保存本次输出，请重试。');
    const blocks = parsed.data.content.filter((block) => block.type === 'text');
    if (!blocks.length || blocks.some((block) => !block.text))
      throw new AiError('Claude 服务返回了空文本。');
    return blocks.map((block) => block.text).join('');
  }
  const parsed = envelope.safeParse(raw);
  if (!parsed.success) throw new AiError('AI 服务返回了无效的 Chat Completions 响应。');
  const choice = parsed.data.choices[0]!;
  if (choice.finish_reason === 'length')
    throw new RepairableError('AI 输出被截断，请缩短总结要求后重试。', TRUNCATED_HINT);
  return choice.message.content;
}

export function safeError(error: unknown): string {
  if (error instanceof AiError) return error.message;
  if (error instanceof DOMException && error.name === 'AbortError') return '任务已取消。';
  return '操作未完成，请检查设置或稍后重试。';
}

export function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  assertNotAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Cancelled', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function readBounded(response: Response): Promise<string> {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    throw new AiError('AI 响应过大，请缩短提示词或减少输出长度。');
  }
  if (!response.body) throw new AiError('AI 服务返回了空响应。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let output = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return output + decoder.decode();
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new AiError('AI 响应过大，请减少输出长度。');
      output += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export interface ClientOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  retryDelayMs?: number;
  permissionCheck?: (origin: string) => Promise<boolean>;
}

/** Per-call tuning: a 30-batch digest pass and a single long summary need different budgets. */
export interface JsonOptions {
  timeoutMs?: number;
  maxTokens?: number;
}

type Attempt<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'http'; error: AiError }
  | { kind: 'timeout'; error: AiError }
  | { kind: 'repair'; error: RepairableError }
  | { kind: 'fatal'; error: AiError };

export class AiClient {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly permissionCheck: (origin: string) => Promise<boolean>;

  constructor(
    private readonly settings: Settings,
    options: ClientOptions = {},
  ) {
    // Chromium's WorkerGlobalScope.fetch requires its native receiver.
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 25_000;
    this.retryDelayMs = options.retryDelayMs ?? 750;
    this.permissionCheck =
      options.permissionCheck ?? ((origin) => chrome.permissions.contains({ origins: [origin] }));
  }

  async json<T>(
    system: string,
    data: unknown,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    options: JsonOptions = {},
  ): Promise<T> {
    assertNotAborted(signal);
    if (!this.settings.apiKey || !this.settings.model.trim())
      throw new AiError('请先设置 API Key 和模型名称。');
    const baseUrl = validateBaseUrl(this.settings.baseUrl);
    const provider = getProvider(this.settings.provider);
    if (!provider && this.settings.provider !== 'custom')
      throw new AiError('AI 提供商无效，请重新选择。');
    const model = provider?.models.find((item) => item.id === this.settings.model);
    if (provider && (provider.baseUrl !== baseUrl || !model))
      throw new AiError('AI 提供商、模型或接口地址不匹配，请重新选择提供商和模型。');
    if (!(await this.permissionCheck(getOriginPattern(baseUrl)))) {
      throw new AiError('尚未授权访问此 API 服务，请在设置中重新保存并允许访问。');
    }
    const anthropic = this.settings.provider === 'anthropic';
    const maxTokens = Math.min(options.maxTokens ?? 6000, model?.maxOutputTokens ?? 6000);
    const url = `${baseUrl}/${anthropic ? 'messages' : 'chat/completions'}`;
    const headers: Record<string, string> = anthropic
      ? {
          'Content-Type': 'application/json',
          'x-api-key': this.settings.apiKey,
          'anthropic-version': '2023-06-01',
          // Official SDK opt-in for browser-origin requests; keys stay in this worker.
          'anthropic-dangerous-direct-browser-access': 'true',
        }
      : { 'Content-Type': 'application/json', Authorization: `Bearer ${this.settings.apiKey}` };

    let httpRetries = 0;
    let repairRetries = 0;
    let timeoutRetries = 0;
    let timeoutMs = options.timeoutMs ?? this.timeoutMs;
    let hint = '';
    let last: AiError = new AiError('AI 服务暂时不可用，请稍后重试。');
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      assertNotAborted(signal);
      const jsonSystem = `${system}\nReturn exactly one complete JSON object, without markdown fences.${
        hint ? `\n\nIMPORTANT — CORRECTION FOR THIS RETRY: ${hint}` : ''
      }`;
      const body = anthropic
        ? {
            model: this.settings.model,
            max_tokens: maxTokens,
            system: jsonSystem,
            messages: [{ role: 'user', content: JSON.stringify(data) }],
            thinking: { type: 'disabled' },
            ...(model?.supportsTemperature
              ? { temperature: Math.min(1, this.settings.temperature) }
              : {}),
          }
        : {
            model: this.settings.model,
            temperature: this.settings.temperature,
            ...(this.settings.provider === 'openai'
              ? { max_completion_tokens: maxTokens, store: false }
              : { max_tokens: maxTokens }),
            ...(this.settings.provider === 'deepseek' ? { thinking: { type: 'disabled' } } : {}),
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: jsonSystem },
              { role: 'user', content: JSON.stringify(data) },
            ],
          };
      const attempt = await this.attempt(url, headers, body, schema, signal, timeoutMs, anthropic);
      if (attempt.kind === 'ok') return attempt.value;
      last = attempt.error;
      if (attempt.kind === 'http' && httpRetries < HTTP_RETRIES) {
        await delay(this.retryDelayMs * 2 ** httpRetries, signal);
        httpRetries += 1;
        continue;
      }
      if (attempt.kind === 'timeout' && timeoutRetries < TIMEOUT_RETRIES) {
        timeoutRetries += 1;
        // A stall may be transient; give the retry more room rather than the same budget.
        timeoutMs = Math.min(Math.round(timeoutMs * 1.5), 120_000);
        await delay(REPAIR_DELAY_MS, signal);
        continue;
      }
      if (attempt.kind === 'repair' && repairRetries < REPAIR_RETRIES) {
        repairRetries += 1;
        hint = attempt.error.hint;
        await delay(REPAIR_DELAY_MS, signal);
        continue;
      }
      throw attempt.error;
    }
    throw last;
  }

  private async attempt<T>(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    timeoutMs: number,
    anthropic: boolean,
  ): Promise<Attempt<T>> {
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await this.fetcher(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
      });
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel();
        return {
          kind: 'http',
          error: new AiError(
            response.status === 429
              ? 'AI 服务限流或额度不足，请稍后重试并检查账户额度。'
              : `AI 服务请求失败（HTTP ${response.status}），请检查模型及接口兼容性。`,
          ),
        };
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403)
          throw new AiError('AI 服务拒绝访问，请检查 API Key、模型权限和账户状态。');
        throw new AiError(`AI 服务请求失败（HTTP ${response.status}），请检查模型及接口兼容性。`);
      }
      const responseText = await readBounded(response);
      let raw: unknown;
      try {
        raw = JSON.parse(responseText);
      } catch {
        throw new RepairableError('AI 服务返回了无效 JSON。', INVALID_JSON_HINT);
      }
      const content = responseContent(raw, anthropic)
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '');
      let value: unknown;
      try {
        value = JSON.parse(content);
      } catch {
        throw new RepairableError('AI 返回的内容不是完整 JSON，请重试。', INVALID_JSON_HINT);
      }
      const result = schema.safeParse(value);
      if (!result.success) {
        const paths = schemaPaths(result.error);
        throw new RepairableError(
          `AI 返回的数据结构不完整${paths ? `（${paths}）` : ''}，未保存本次结果，请重试。`,
          schemaHint(result.error),
          paths,
        );
      }
      return { kind: 'ok', value: result.data };
    } catch (error) {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (timedOut)
        return {
          kind: 'timeout',
          error: new AiError('AI 请求超时，请重试或选择响应更快的模型。'),
        };
      if (error instanceof RepairableError) return { kind: 'repair', error };
      if (error instanceof AiError) return { kind: 'fatal', error };
      return {
        kind: 'fatal',
        error: new AiError('无法连接 AI 服务，请检查网络、API 地址及接口兼容性。'),
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }
}
