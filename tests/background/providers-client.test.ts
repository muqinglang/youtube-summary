import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AiClient, safeError } from '../../src/background/client';
import { DEFAULT_SETTINGS } from '../../src/background/settings';
import { PROVIDERS } from '../../src/shared/providers';
import type { Settings } from '../../src/shared/types';

const schema = z.object({ ok: z.literal(true) });
const signal = () => new AbortController().signal;
const presets = PROVIDERS.flatMap((provider) =>
  provider.models.map((model) => ({ provider, model })),
);
const anthropic = PROVIDERS.find((provider) => provider.id === 'anthropic')!;
const claudeSettings: Settings = {
  ...DEFAULT_SETTINGS,
  provider: 'anthropic',
  baseUrl: anthropic.baseUrl,
  model: anthropic.defaultModel,
  apiKey: 'private-claude-key',
};
const claudeResponse = (value: unknown, stop_reason = 'end_turn') =>
  new Response(
    JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify(value) }],
      stop_reason,
    }),
  );

describe('built-in provider protocols', () => {
  it.each(presets)(
    'uses the native request contract for $model.id',
    async ({ provider, model }) => {
      const settings = {
        ...DEFAULT_SETTINGS,
        provider: provider.id,
        baseUrl: provider.baseUrl,
        model: model.id,
        apiKey: 'private-key',
        temperature: 1.8,
      };
      const isClaude = provider.id === 'anthropic';
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        isClaude
          ? claudeResponse({ ok: true })
          : new Response(
              JSON.stringify({
                choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
              }),
            ),
      );
      const permissionCheck = vi.fn(async () => true);
      const client = new AiClient(settings, { fetch: fetcher, permissionCheck });
      await expect(
        client.json(
          'Use source as evidence.',
          { source: 'Untrusted transcript' },
          schema,
          signal(),
        ),
      ).resolves.toEqual({ ok: true });
      const [url, options] = fetcher.mock.calls[0]!;
      expect(url).toBe(`${provider.baseUrl}/${isClaude ? 'messages' : 'chat/completions'}`);
      expect(permissionCheck).toHaveBeenCalledWith(`${new URL(provider.baseUrl).origin}/*`);
      expect(options).toMatchObject({
        method: 'POST',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
      });
      const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
      expect(body.model).toBe(model.id);
      const outputLimit = Number(body.max_tokens ?? body.max_completion_tokens);
      expect(outputLimit).toBe(6000);
      expect(outputLimit).toBeLessThanOrEqual(model.maxOutputTokens);
      if (isClaude) {
        expect(options?.headers).toEqual({
          'Content-Type': 'application/json',
          'x-api-key': 'private-key',
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        });
        expect(body.system).toContain('Use source as evidence.');
        expect(body.system).toContain('JSON');
        expect(body.messages).toEqual([
          { role: 'user', content: '{"source":"Untrusted transcript"}' },
        ]);
        expect(body.thinking).toEqual({ type: 'disabled' });
        expect(body).not.toHaveProperty('response_format');
        if (model.supportsTemperature) expect(body.temperature).toBe(1);
        else expect(body).not.toHaveProperty('temperature');
      } else {
        expect(options?.headers).toEqual({
          'Content-Type': 'application/json',
          Authorization: 'Bearer private-key',
        });
        expect(body.response_format).toEqual({ type: 'json_object' });
        expect(body.temperature).toBe(1.8);
        if (provider.id === 'deepseek') {
          expect(body.thinking).toEqual({ type: 'disabled' });
          expect(body).toHaveProperty('max_tokens');
          expect(body).not.toHaveProperty('max_completion_tokens');
        } else {
          expect(body).toHaveProperty('max_completion_tokens');
          expect(body).not.toHaveProperty('max_tokens');
          expect(body.store).toBe(false);
        }
      }
    },
  );

  it.each([
    { provider: 'anthropic', baseUrl: 'https://attacker.example/v1' },
    { provider: 'anthropic', model: 'gpt-4.1-mini' },
    { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'claude-sonnet-5' },
    { provider: 'invalid' },
  ])(
    'rejects invalid provider routing before any permission or network request: %j',
    async (patch) => {
      const fetcher = vi.fn<typeof fetch>();
      const permissionCheck = vi.fn(async () => true);
      const client = new AiClient({ ...claudeSettings, ...patch } as Settings, {
        fetch: fetcher,
        permissionCheck,
      });
      await expect(client.json('JSON', {}, schema, signal())).rejects.toThrow('提供商');
      expect(fetcher).not.toHaveBeenCalled();
      expect(permissionCheck).not.toHaveBeenCalled();
    },
  );

  it('keeps an explicitly migrated custom endpoint on the existing Chat Completions contract', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] })),
      );
    const client = new AiClient(
      {
        ...DEFAULT_SETTINGS,
        provider: 'custom',
        baseUrl: 'http://127.0.0.1:8181/v1',
        model: 'legacy-model',
        apiKey: 'local-key',
      },
      { fetch: fetcher, permissionCheck: async () => true },
    );
    await expect(client.json('JSON', {}, schema, signal())).resolves.toEqual({ ok: true });
    expect(fetcher.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8181/v1/chat/completions');
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'legacy-model',
      max_tokens: 6000,
    });
  });

  it('reads Claude text blocks by type without treating a thinking block as the JSON result', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [
            { type: 'thinking', thinking: 'ignored' },
            { type: 'text', text: '{"ok":' },
            { type: 'text', text: 'true}' },
          ],
          stop_reason: 'end_turn',
        }),
      ),
    );
    await expect(
      new AiClient(claudeSettings, { fetch: fetcher, permissionCheck: async () => true }).json(
        'JSON',
        {},
        schema,
        signal(),
      ),
    ).resolves.toEqual({ ok: true });
  });

  it.each([
    { content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'max_tokens' },
    { content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'refusal' },
    {
      content: [{ type: 'text', text: '{"ok":true}' }],
      stop_reason: 'end_turn',
      stop_details: { type: 'refusal' },
    },
    { content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'tool_use' },
    { content: [{ type: 'text', text: '{partial' }], stop_reason: 'end_turn' },
    { content: [{ type: 'text', text: '{"wrong":true}' }], stop_reason: 'end_turn' },
    { content: [{ type: 'thinking' }], stop_reason: 'end_turn' },
    { choices: [{ message: { content: '{"ok":true}' } }] },
  ])('rejects incomplete or nonconforming Claude output: %j', async (response) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response)));
    await expect(
      new AiClient(claudeSettings, { fetch: fetcher, permissionCheck: async () => true }).json(
        'JSON',
        {},
        schema,
        signal(),
      ),
    ).rejects.toMatchObject({ name: 'AiError' });
  });

  it('retains bounded retries and redacts native provider error bodies', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('Busy', { status: 529 }))
      .mockResolvedValueOnce(claudeResponse({ ok: true }));
    const client = new AiClient(claudeSettings, {
      fetch: fetcher,
      permissionCheck: async () => true,
      retryDelayMs: 1,
    });
    await expect(client.json('JSON', {}, schema, signal())).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockResolvedValueOnce(new Response('private-claude-key refused', { status: 401 }));
    const error = await client.json('JSON', {}, schema, signal()).catch((error: unknown) => error);
    expect(safeError(error)).toContain('拒绝访问');
    expect(safeError(error)).not.toContain('private-claude-key');
  });

  it('cancels a native Claude request and does not consume a late result', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
      controller.abort();
      expect(options?.signal?.aborted).toBe(true);
      throw new DOMException('Cancelled', 'AbortError');
    });
    await expect(
      new AiClient(claudeSettings, { fetch: fetcher, permissionCheck: async () => true }).json(
        'JSON',
        {},
        schema,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
