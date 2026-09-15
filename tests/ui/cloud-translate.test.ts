import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { translateCuesCloud } from '../../src/ui/cloud-translate';
import type { Cue } from '../../src/shared/types';

const cue = (id: string, text: string): Cue => ({ id, start: 0, end: 1, text });

/** Answers the way Google's endpoint does; `status` decides each attempt for each sentence. */
function google(status: (text: string, attempt: number) => number) {
  const attempts = new Map<string, number>();
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const text = new URL(String(input)).searchParams.get('q') ?? '';
    const attempt = (attempts.get(text) ?? 0) + 1;
    attempts.set(text, attempt);
    const code = status(text, attempt);
    if (code !== 200) return new Response('', { status: code });
    return new Response(JSON.stringify([[[`译:${text}`, text]]]));
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

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

  it('retries a server error before counting a sentence as failed', async () => {
    const fetcher = google((_text, attempt) => (attempt === 1 ? 500 : 200));
    await expect(translate([cue('a', 'Hello.')])).resolves.toEqual({
      translations: { a: '译:Hello.' },
      failed: [],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
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
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it('skips a sentence Google cannot translate, without retrying it or stopping', async () => {
    const fetcher = google((text) => (text === '♪' ? 400 : 200));
    await expect(translate([cue('a', '♪')])).resolves.toEqual({ translations: {}, failed: ['a'] });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
