import { z } from 'zod';
import type { Settings } from '../shared/types';
import { getOriginPattern, validateBaseUrl } from '../shared/endpoint';
import { getProvider, type ModelProtocol } from '../shared/providers';

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

/** Reasoning models answer here instead: the text sits in an output item, beside its thinking. */
const responsesEnvelope = z.object({
  status: z.string().max(100).nullable().optional(),
  incomplete_details: z.object({ reason: z.string().max(200) }).nullable().optional(),
  output: z
    .array(
      z.object({
        type: z.string().max(100),
        content: z
          .array(
            z.object({
              type: z.string().max(100),
              text: z.string().max(MAX_RESPONSE_BYTES).optional(),
            }),
          )
          .max(100)
          .optional(),
      }),
    )
    .max(100),
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

function responseContent(raw: unknown, protocol: ModelProtocol): string {
  if (protocol === 'responses') {
    const parsed = responsesEnvelope.safeParse(raw);
    if (!parsed.success) throw new AiError('AI 服务返回了无效的 Responses 响应。');
    if (parsed.data.incomplete_details?.reason.includes('max_output_tokens'))
      throw new RepairableError('AI 输出被截断，请缩短总结要求后重试。', TRUNCATED_HINT);
    const blocks = parsed.data.output.flatMap((item) => item.content ?? []);
    if (blocks.some((block) => block.type === 'refusal'))
      throw new AiError('AI 未完成此请求，请调整问题或总结要求后重试。');
    // Reasoning items carry no text of their own, so an empty answer is a real failure.
    const text = blocks
      .filter((block) => block.type === 'output_text')
      .map((block) => block.text ?? '')
      .join('');
    if (!text) throw new AiError('AI 服务返回了空文本。');
    return text;
  }
  if (protocol === 'messages') {
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

/**
 * What the platform said went wrong, so "cannot connect" is something a person can act on rather
 * than a dead end. Only the failure's own message and its causes: never a header, a body or a key.
 * Node hides the real reason one `cause` down from "fetch failed", so the chain is followed.
 */
function connectionReason(error: unknown): string {
  const reasons: string[] = [];
  let cause: unknown = error;
  for (let depth = 0; cause instanceof Error && depth < 3; depth += 1) {
    if (cause.message) reasons.push(cause.message);
    cause = (cause as { cause?: unknown }).cause;
  }
  return reasons.join(' · ').slice(0, 160) || '未知错误';
}

/**
 * A provider's own words are often the only thing that says what to do — a model to opt in to, a
 * balance to top up, a region to enable. Only a structured `error.message` is taken, never the raw
 * body, and anything shaped like a credential is removed on the way out: an endpoint is free to
 * echo the request back at us, and this string is shown in the panel.
 */
export function providerMessage(body: string, apiKey: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return '';
  }
  const error = (parsed as { error?: unknown }).error;
  const message =
    typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : error;
  if (typeof message !== 'string' || !message.trim()) return '';
  const redacted = apiKey ? message.split(apiKey).join('***') : message;
  return redacted.replace(/\b(?:sk|pk|api)[-_][\w-]{8,}/gi, '***').trim().slice(0, 300);
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

/**
 * opencode routes and caches by conversation, and its Go endpoint refuses outright a request that
 * names none ("MissingSessionID"). One id per worker run keeps this extension's calls together,
 * which is what the header is for: https://opencode.ai/docs/go/#where-can-i-use-it
 */
let conversation = '';
function conversationId(): string {
  conversation ||= crypto.randomUUID();
  return conversation;
}

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
    // A protocol belongs to the model, not to the service hosting it: one gateway serves Chat
    // Completions and Responses models side by side under the same key and base URL.
    const protocol: ModelProtocol =
      model?.protocol ?? (this.settings.provider === 'anthropic' ? 'messages' : 'chat');
    const anthropic = protocol === 'messages';
    const maxTokens = Math.min(options.maxTokens ?? 6000, model?.maxOutputTokens ?? 6000);
    const path =
      protocol === 'messages' ? 'messages' : protocol === 'responses' ? 'responses' : 'chat/completions';
    const url = `${baseUrl}/${path}`;
    const headers: Record<string, string> = anthropic
      ? {
          'Content-Type': 'application/json',
          'x-api-key': this.settings.apiKey,
          'anthropic-version': '2023-06-01',
          // Official SDK opt-in for browser-origin requests; keys stay in this worker.
          'anthropic-dangerous-direct-browser-access': 'true',
        }
      : { 'Content-Type': 'application/json', Authorization: `Bearer ${this.settings.apiKey}` };
    if (this.settings.provider.startsWith('opencode'))
      headers['x-opencode-session'] = conversationId();

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
      const temperature = model?.supportsTemperature === false ? {} : { temperature: this.settings.temperature };
      const body =
        protocol === 'responses'
          ? {
              model: this.settings.model,
              max_output_tokens: maxTokens,
              // The system text goes in `input` rather than `instructions`: JSON mode is refused
              // unless one of the input messages says the word "json", and this one does.
              input: [
                { role: 'system', content: jsonSystem },
                { role: 'user', content: JSON.stringify(data) },
              ],
              text: { format: { type: 'json_object' } },
              ...temperature,
            }
          : anthropic
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
            // A preset model that refuses a temperature (the GPT-5 family) is sent none at all.
            ...temperature,
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
      const attempt = await this.attempt(url, headers, body, schema, signal, timeoutMs, protocol);
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
    protocol: ModelProtocol,
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
      if (!response.ok) {
        const said = providerMessage(await readBounded(response).catch(() => ''), this.settings.apiKey);
        const because = said ? `服务商说明：${said}` : '';
        if (response.status === 429 || response.status >= 500) {
          return {
            kind: 'http',
            error: new AiError(
              (response.status === 429
                ? 'AI 服务限流或额度不足，请稍后重试并检查账户额度。'
                : `AI 服务请求失败（HTTP ${response.status}），请检查模型及接口兼容性。`) + because,
            ),
          };
        }
        if (response.status === 401 || response.status === 403)
          throw new AiError(
            said
              ? `AI 服务拒绝访问。${because}`
              : 'AI 服务拒绝访问，请检查 API Key、模型权限和账户状态。',
          );
        throw new AiError(
          `AI 服务请求失败（HTTP ${response.status}），请检查模型及接口兼容性。${because}`,
        );
      }
      const responseText = await readBounded(response);
      let raw: unknown;
      try {
        raw = JSON.parse(responseText);
      } catch {
        throw new RepairableError('AI 服务返回了无效 JSON。', INVALID_JSON_HINT);
      }
      const content = responseContent(raw, protocol)
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
        error: new AiError(
          `无法连接 AI 服务（${new URL(url).host}）：${connectionReason(error)}。请检查网络、API 地址及接口兼容性。`,
        ),
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }
}
