import { z } from 'zod';
import type { EmbeddingConfig } from '../config';

const REQUEST_TIMEOUT_MS = 30_000;
const RETRIES = 2;
const RETRY_DELAY_MS = 500;
/** Guards against a misconfigured endpoint streaming an unbounded body into memory. */
const MAX_RESPONSE_BYTES = 8_000_000;

export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

const responseSchema = z.object({
  data: z
    .array(
      z.object({
        index: z.number().int().min(0).optional(),
        embedding: z.array(z.number()).min(1),
      }),
    )
    .min(1),
});

export interface EmbedderOptions {
  fetch?: typeof globalThis.fetch;
  /** Zero in tests, so a retry path costs no wall-clock; production wants the backoff. */
  retryDelayMs?: number;
}

export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  /** Returns one vector per input, in input order. */
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new EmbeddingError('已取消。'));
      },
      { once: true },
    );
  });
}

/**
 * Speaks the OpenAI `/embeddings` shape, which Bailian, OpenAI, SiliconFlow and most others
 * accept. Everything that differs between them — endpoint, model, dimensions, batch size — is
 * configuration, so switching provider is an environment change rather than a code change.
 */
export function createEmbedder(config: EmbeddingConfig, options: EmbedderOptions = {}): Embedder {
  const fetcher = options.fetch ?? globalThis.fetch;
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  const url = `${config.baseUrl}/embeddings`;

  async function once(batch: string[], signal: AbortSignal | undefined): Promise<number[][]> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await fetcher(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        input: batch,
        dimensions: config.dimensions,
        encoding_format: 'float',
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      // The body can echo the request; only the status is safe to surface and enough to act on.
      throw new EmbeddingError(`向量服务返回 ${response.status}。`);
    }
    const raw = await response.text();
    if (raw.length > MAX_RESPONSE_BYTES) throw new EmbeddingError('向量服务返回内容过大。');
    let parsed: z.infer<typeof responseSchema>;
    try {
      parsed = responseSchema.parse(JSON.parse(raw));
    } catch {
      throw new EmbeddingError('向量服务返回了无法识别的响应。');
    }
    if (parsed.data.length !== batch.length)
      throw new EmbeddingError(
        `向量服务返回了 ${parsed.data.length} 个向量，与 ${batch.length} 条输入不符。`,
      );
    const ordered = new Array<number[]>(batch.length);
    parsed.data.forEach((item, position) => {
      const slot = item.index ?? position;
      if (slot < batch.length) ordered[slot] = item.embedding;
    });
    for (const vector of ordered) {
      if (!vector) throw new EmbeddingError('向量服务返回的下标不连续。');
      // A silently ignored `dimensions` parameter would otherwise corrupt every stored row.
      if (vector.length !== config.dimensions)
        throw new EmbeddingError(
          `向量维度是 ${vector.length}，与配置的 ${config.dimensions} 不符：` +
            `请把 SIDENOTE_EMBEDDING_DIMENSIONS 改成该模型实际输出的维度。`,
        );
    }
    return ordered;
  }

  return {
    model: config.model,
    dimensions: config.dimensions,
    async embed(texts, signal) {
      const inputs = texts.map((text) => text.trim()).filter(Boolean);
      if (inputs.length !== texts.length) throw new EmbeddingError('待向量化的文本不能为空。');
      const vectors: number[][] = [];
      for (let start = 0; start < inputs.length; start += config.batchSize) {
        const batch = inputs.slice(start, start + config.batchSize);
        let lastError: unknown;
        for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
          signal?.throwIfAborted();
          try {
            vectors.push(...(await once(batch, signal)));
            lastError = undefined;
            break;
          } catch (error) {
            lastError = error;
            if (attempt < RETRIES) await delay(retryDelayMs * (attempt + 1), signal);
          }
        }
        if (lastError) throw lastError;
      }
      return vectors;
    },
  };
}

/** Cosine similarity in [-1, 1]; 1 is identical. Mirrors what pgvector's `<=>` orders by. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let index = 0; index < a.length && index < b.length; index += 1) {
    dot += a[index]! * b[index]!;
    left += a[index]! * a[index]!;
    right += b[index]! * b[index]!;
  }
  const magnitude = Math.sqrt(left) * Math.sqrt(right);
  return magnitude ? dot / magnitude : 0;
}
