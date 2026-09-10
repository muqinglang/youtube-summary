import { describe, expect, it, vi } from 'vitest';
import { cosineSimilarity, createEmbedder, EmbeddingError } from '../../server/ai/embeddings';
import type { EmbeddingConfig } from '../../server/config';

const CONFIG: EmbeddingConfig = {
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'text-embedding-v3',
  apiKey: 'secret-key-that-must-not-leak',
  dimensions: 4,
  batchSize: 2,
};

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function vectorsFor(count: number, offset = 0): { data: { index: number; embedding: number[] }[] } {
  return {
    data: Array.from({ length: count }, (_, index) => ({
      index,
      embedding: [offset + index, 0, 0, 1],
    })),
  };
}

describe('embedding client', () => {
  it('splits into batches, keeps input order and sends the key only as a bearer header', async () => {
    const seen: { body: unknown; headers: Headers; url: string }[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body)) as { input: string[] };
      seen.push({ body, headers: new Headers(init!.headers), url: String(url) });
      return reply(vectorsFor(body.input.length, seen.length * 10));
    });
    const embedder = createEmbedder(CONFIG, {
      fetch: fetcher as unknown as typeof globalThis.fetch,
      retryDelayMs: 0,
    });

    const vectors = await embedder.embed(['one', 'two', 'three']);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(seen[0]!.url).toBe(`${CONFIG.baseUrl}/embeddings`);
    expect(seen.map((call) => (call.body as { input: string[] }).input)).toEqual([
      ['one', 'two'],
      ['three'],
    ]);
    expect(seen[0]!.headers.get('authorization')).toBe(`Bearer ${CONFIG.apiKey}`);
    // The batch boundary must not scramble the correspondence with the inputs.
    expect(vectors.map((vector) => vector[0])).toEqual([10, 11, 20]);
    expect((seen[0]!.body as { dimensions: number }).dimensions).toBe(4);
  });

  it('places each vector by the index the provider reports, not by arrival order', async () => {
    const fetcher = vi.fn(async () =>
      reply({
        data: [
          { index: 1, embedding: [9, 0, 0, 1] },
          { index: 0, embedding: [8, 0, 0, 1] },
        ],
      }),
    );
    const embedder = createEmbedder(CONFIG, {
      fetch: fetcher as unknown as typeof globalThis.fetch,
      retryDelayMs: 0,
    });
    expect((await embedder.embed(['a', 'b'])).map((vector) => vector[0])).toEqual([8, 9]);
  });

  it('names the setting to change when the model ignores the requested dimensions', async () => {
    const fetcher = vi.fn(async () => reply({ data: [{ index: 0, embedding: [1, 2, 3] }] }));
    const embedder = createEmbedder(CONFIG, {
      fetch: fetcher as unknown as typeof globalThis.fetch,
      retryDelayMs: 0,
    });
    // Silently storing a 3-wide vector in a 4-wide column is the failure this prevents.
    await expect(embedder.embed(['a'])).rejects.toThrow('SIDENOTE_EMBEDDING_DIMENSIONS');
  });

  it('retries a server error, then reports only the status', async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls += 1;
      return calls < 3 ? reply({ error: 'rate limited' }, 503) : reply(vectorsFor(1));
    });
    const embedder = createEmbedder(CONFIG, {
      fetch: fetcher as unknown as typeof globalThis.fetch,
      retryDelayMs: 0,
    });
    await expect(embedder.embed(['a'])).resolves.toHaveLength(1);
    expect(calls).toBe(3);

    const failing = createEmbedder(CONFIG, {
      fetch: (async () =>
        reply(
          { error: 'quota exceeded for key sk-abc' },
          401,
        )) as unknown as typeof globalThis.fetch,
      retryDelayMs: 0,
    });
    // The body can echo the request or the credential; the status is enough to act on.
    await expect(failing.embed(['a'])).rejects.toThrow('向量服务返回 401。');
    await expect(failing.embed(['a'])).rejects.not.toThrow(/sk-abc/);
  });

  it('rejects an unparseable body and a short count rather than storing junk', async () => {
    const garbage = createEmbedder(CONFIG, {
      fetch: (async () =>
        new Response('<html>gateway</html>', {
          status: 200,
        })) as unknown as typeof globalThis.fetch,
      retryDelayMs: 0,
    });
    await expect(garbage.embed(['a'])).rejects.toBeInstanceOf(EmbeddingError);

    const short = createEmbedder(CONFIG, {
      fetch: (async () => reply(vectorsFor(1))) as unknown as typeof globalThis.fetch,
      retryDelayMs: 0,
    });
    await expect(short.embed(['a', 'b'])).rejects.toThrow('与 2 条输入不符');
  });

  it('refuses blank input instead of paying for an empty vector', async () => {
    const fetcher = vi.fn(async () => reply(vectorsFor(1)));
    const embedder = createEmbedder(CONFIG, {
      fetch: fetcher as unknown as typeof globalThis.fetch,
      retryDelayMs: 0,
    });
    await expect(embedder.embed(['ok', '   '])).rejects.toThrow('不能为空');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('cosine similarity', () => {
  it('scores identical vectors 1, opposite -1 and orthogonal 0', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    // Direction, not magnitude: a doubled vector is the same point in the space.
    expect(cosineSimilarity([1, 2], [2, 4])).toBeCloseTo(1);
    // A zero vector has no direction; returning 0 keeps it out of every result list.
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});
