import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { translateCuesCloud } from '../../src/ui/cloud-translate';
import type { Cue } from '../../src/shared/types';

const cue = (id: string, text: string): Cue => ({ id, start: 0, end: 1, text });

/**
 * Answers the way Google's endpoints do. `status` decides each per-sentence attempt; `batch` is
 * how the widget endpoint behaves — 'ok' in order, 'ragged' one translation short, 'off' refusing,
 * which is what sends a group down the per-sentence path.
 */
function google(
  status: (text: string, attempt: number) => number,
  batch: 'ok' | 'ragged' | 'off' = 'off',
) {
  const attempts = new Map<string, number>();
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const href = String(input);
    if (href.startsWith('https://translate-pa.googleapis.com/')) {
      if (batch === 'off') return new Response('', { status: 500 });
      const sent = JSON.parse(String(init?.body)) as [[string[], string, string], string];
      const texts = sent[0][0];
      const translated = batch === 'ragged' ? texts.slice(1) : texts.map((text) => `译:${text}`);
      return new Response(JSON.stringify([translated, texts.map(() => 'en')]));
    }
    const text = new URL(href).searchParams.get('q') ?? '';
    const attempt = (attempts.get(text) ?? 0) + 1;
    attempts.set(text, attempt);
    const code = status(text, attempt);
    if (code !== 200) return new Response('', { status: code });
    return new Response(JSON.stringify([[[`译:${text}`, text]]]));
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

const sentenceCalls = (fetcher: ReturnType<typeof google>) =>
  fetcher.mock.calls.filter(([input]) => String(input).includes('translate_a')).length;

async function translate(cues: Cue[]) {
  const pending = translateCuesCloud(cues, '简体中文', new AbortController().signal);
  // Observed before the timers run, so a rejection is not reported as unhandled.
  pending.catch(() => undefined);
  // The pauses between retries pass instantly.
  await vi.runAllTimersAsync();
  return pending;
}

describe('cloud translation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('translates a whole group in one request rather than one request per sentence', async () => {
    const fetcher = google(() => 200, 'ok');
    const cues = Array.from({ length: 40 }, (_, index) => cue(`c${index}`, `Line ${index}.`));
    const { translations, failed } = await translate(cues);
    expect(failed).toEqual([]);
    expect(translations.c0).toBe('译:Line 0.');
    expect(translations.c39).toBe('译:Line 39.');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('sends markup-looking text as text, and brings it back as text', async () => {
    google(() => 200, 'ok');
    const { translations } = await translate([cue('a', '3 < 5 & rising')]);
    expect(translations.a).toBe('译:3 < 5 & rising');
  });

  it('falls back to one sentence at a time when the batch answer cannot be lined up', async () => {
    const fetcher = google(() => 200, 'ragged');
    const { translations, failed } = await translate([cue('a', 'Hello.'), cue('b', 'Bye.')]);
    expect(failed).toEqual([]);
    expect(translations).toEqual({ a: '译:Hello.', b: '译:Bye.' });
    expect(sentenceCalls(fetcher)).toBe(2);
  });

  it('retries a server error before counting a sentence as failed', async () => {
    const fetcher = google((_text, attempt) => (attempt === 1 ? 500 : 200));
    await expect(translate([cue('a', 'Hello.')])).resolves.toEqual({
      translations: { a: '译:Hello.' },
      failed: [],
    });
    expect(sentenceCalls(fetcher)).toBe(2);
  });

  it('keeps the rest of a batch when one sentence still fails', async () => {
    google((text) => (text === 'Broken.' ? 500 : 200));
    await expect(
      translate([cue('a', 'Hello.'), cue('b', 'Broken.'), cue('c', 'Bye.')]),
    ).resolves.toEqual({ translations: { a: '译:Hello.', c: '译:Bye.' }, failed: ['b'] });
  });

  it('stops when nothing gets through, which is the endpoint failing rather than a sentence', async () => {
    const fetcher = google(() => 500);
    await expect(translate([cue('a', 'Hello.'), cue('b', 'Bye.')])).rejects.toThrow('HTTP 500');
    // Each sentence had its two retries, and no more.
    expect(sentenceCalls(fetcher)).toBe(6);
  });

  it('gives up on a request that never answers, instead of translating forever', async () => {
    const fetcher = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    await expect(translate([cue('a', 'Hello.')])).rejects.toThrow('超时');
    // The batch request and then the sentence's three attempts, each on its own deadline.
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('skips a sentence Google cannot translate, without retrying it or stopping', async () => {
    const fetcher = google((text) => (text === '♪' ? 400 : 200));
    await expect(translate([cue('a', '♪')])).resolves.toEqual({ translations: {}, failed: ['a'] });
    expect(sentenceCalls(fetcher)).toBe(1);
  });
});
