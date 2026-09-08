import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AiClient, AiError, safeError } from '../../src/background/client';
import { DEFAULT_SETTINGS } from '../../src/background/settings';

const settings = { ...DEFAULT_SETTINGS, apiKey: 'private-test-key' };
const schema = z.object({ ok: z.literal(true) });
const response = (value: unknown) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }],
    }),
    { status: 200 },
  );
const signal = () => new AbortController().signal;

describe('OpenAI-compatible client', () => {
  it('retains the WorkerGlobalScope receiver when using native fetch', async () => {
    const nativeFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(response({ ok: true }));
    });
    try {
      const client = new AiClient(settings, { permissionCheck: async () => true });
      await expect(client.json('', {}, schema, signal())).resolves.toEqual({ ok: true });
      expect(nativeFetch).toHaveBeenCalledOnce();
      expect(nativeFetch.mock.contexts[0]).toBe(globalThis);
    } finally {
      nativeFetch.mockRestore();
    }
  });

  it('uses the authorized endpoint with worker-only credentials and validates JSON', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ ok: true }));
    const permissionCheck = vi.fn(async () => true);
    const client = new AiClient(settings, { fetch: fetcher, permissionCheck });
    await expect(client.json('JSON only', { source: 'test' }, schema, signal())).resolves.toEqual({
      ok: true,
    });
    expect(permissionCheck).toHaveBeenCalledWith('https://api.openai.com/*');
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(options?.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer private-test-key',
    });
    expect(options?.redirect).toBe('error');
    expect(options?.credentials).toBe('omit');
    const body = JSON.parse(String(options?.body)) as {
      messages: { role: string; content: string }[];
    };
    expect(body.messages[1]?.content).toBe('{"source":"test"}');
  });

  it('does not send a request without endpoint permission or credentials', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      new AiClient(settings, { fetch: fetcher, permissionCheck: async () => false }).json(
        '',
        {},
        schema,
        signal(),
      ),
    ).rejects.toThrow('尚未授权');
    await expect(
      new AiClient(DEFAULT_SETTINGS, { fetch: fetcher }).json('', {}, schema, signal()),
    ).rejects.toThrow('API Key');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('retries transient HTTP failures a bounded number of times', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('limited', { status: 429 }))
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(response({ ok: true }));
    const client = new AiClient(settings, {
      fetch: fetcher,
      permissionCheck: async () => true,
      retryDelayMs: 1,
    });
    expect(await client.json('', {}, schema, signal())).toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const failing = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response('private-test-key', { status: 500 }));
    await expect(
      new AiClient(settings, {
        fetch: failing,
        permissionCheck: async () => true,
        retryDelayMs: 1,
      }).json('', {}, schema, signal()),
    ).rejects.toThrow('HTTP 500');
    expect(failing).toHaveBeenCalledTimes(3);
  });

  it('does not echo provider errors or network messages containing secrets', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('private-test-key unauthorized', { status: 401 }));
    const client = new AiClient(settings, { fetch: fetcher, permissionCheck: async () => true });
    const error = await client.json('', {}, schema, signal()).catch((value: unknown) => value);
    expect(safeError(error)).not.toContain('private-test-key');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(safeError(new Error('Bearer secret'))).not.toContain('secret');
    expect(safeError(new AiError('操作提示'))).toBe('操作提示');
  });

  it.each([
    new Response('not JSON'),
    new Response(JSON.stringify({ error: 'bad' })),
    response({ nope: true }),
    new Response(JSON.stringify({ choices: [{ message: { content: '{partial' } }] })),
    new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'length' }],
      }),
    ),
    new Response('small', { headers: { 'content-length': '3000000' } }),
  ])('rejects malformed, truncated or oversized responses', async (badResponse) => {
    const client = new AiClient(settings, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(badResponse),
      permissionCheck: async () => true,
    });
    await expect(client.json('', {}, schema, signal())).rejects.toBeInstanceOf(AiError);
  });

  it('times out stalled calls and distinguishes cancellation', async () => {
    const stalled: typeof fetch = async (_url, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    const client = new AiClient(settings, {
      fetch: stalled,
      permissionCheck: async () => true,
      timeoutMs: 10,
    });
    await expect(client.json('', {}, schema, signal())).rejects.toThrow('超时');
    const controller = new AbortController();
    const cancelled = new AiClient(settings, {
      fetch: stalled,
      permissionCheck: async () => true,
      timeoutMs: 1000,
    }).json('', {}, schema, controller.signal);
    setTimeout(() => controller.abort(), 5);
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort();
    await expect(client.json('', {}, schema, alreadyCancelled.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('malformed-output recovery', () => {
  const body = (init: RequestInit | undefined) =>
    JSON.parse(String(init?.body)) as {
      messages: { role: string; content: string }[];
      max_completion_tokens?: number;
    };

  it('repairs a schema mismatch by retrying with the offending paths fed back', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => response({ nope: true }))
      .mockImplementationOnce(async () => response({ ok: true }));
    const client = new AiClient(settings, {
      fetch: fetcher,
      permissionCheck: async () => true,
      retryDelayMs: 1,
    });
    await expect(client.json('base system', {}, schema, signal())).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const retry = body(fetcher.mock.calls[1]?.[1]).messages[0]!.content;
    expect(retry).toContain('CORRECTION FOR THIS RETRY');
    expect(retry).toContain('ok');
    // The original instructions survive the correction.
    expect(retry).toContain('base system');
  });

  it('asks for a shorter object after a truncated reply', async () => {
    const truncated = () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'length' }],
        }),
      );
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => truncated())
      .mockImplementationOnce(async () => response({ ok: true }));
    const client = new AiClient(settings, {
      fetch: fetcher,
      permissionCheck: async () => true,
      retryDelayMs: 1,
    });
    await expect(client.json('', {}, schema, signal())).resolves.toEqual({ ok: true });
    expect(body(fetcher.mock.calls[1]?.[1]).messages[0]!.content).toContain('cut off');
  });

  it('recovers from a reply wrapped in prose or fences', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: 'Sure! {"ok":true}' } }] }),
          ),
      )
      .mockImplementationOnce(async () => response({ ok: true }));
    const client = new AiClient(settings, {
      fetch: fetcher,
      permissionCheck: async () => true,
      retryDelayMs: 1,
    });
    await expect(client.json('', {}, schema, signal())).resolves.toEqual({ ok: true });
    expect(body(fetcher.mock.calls[1]?.[1]).messages[0]!.content).toContain('not parseable JSON');
  });

  it('bounds repair attempts and names the offending path in the final error', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response({ nope: true }));
    const client = new AiClient(settings, {
      fetch: fetcher,
      permissionCheck: async () => true,
      retryDelayMs: 1,
    });
    await expect(client.json('', {}, schema, signal())).rejects.toThrow('（ok）');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('applies the per-call output budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response({ ok: true }));
    const client = new AiClient(settings, { fetch: fetcher, permissionCheck: async () => true });
    await client.json('', {}, schema, signal(), { maxTokens: 8000 });
    expect(body(fetcher.mock.calls[0]?.[1]).max_completion_tokens).toBe(8000);
  });
});
