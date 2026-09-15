import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  observedCaption,
  rememberCaptionRequest,
  transcriptFromObserved,
  withObservedCaptions,
} from '../../src/background/captions';

const VIDEO = 'p8JYtEYZHcA';
const timedtext = (params: Record<string, string>) =>
  `https://www.youtube.com/api/timedtext?${new URLSearchParams({ v: VIDEO, lang: 'en', ...params }).toString()}`;
const JSON3 = JSON.stringify({
  events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Hello there.' }] }],
});

let session: Record<string, unknown>;
beforeEach(() => {
  session = {};
  vi.stubGlobal('chrome', {
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: structuredClone(session[key]) })),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(session, structuredClone(values));
        }),
      },
    },
  });
});

describe('caption URLs the player used', () => {
  it('keeps only YouTube caption requests that carry the player token', () => {
    expect(observedCaption(timedtext({ kind: 'asr', pot: 'token' }))).toMatchObject({
      videoId: VIDEO,
      language: 'en',
      automatic: true,
    });
    // Without the token the page fetches the URL itself.
    expect(observedCaption(timedtext({ kind: 'asr' }))).toBeUndefined();
    // A translation of a track is not the track.
    expect(observedCaption(timedtext({ pot: 'token', tlang: 'zh-CN' }))).toBeUndefined();
    expect(
      observedCaption(`https://evil.example/api/timedtext?v=${VIDEO}&lang=en&pot=token`),
    ).toBeUndefined();
  });

  it("reads the requested track from the player's URL, and prefers a person's captions otherwise", async () => {
    await rememberCaptionRequest(timedtext({ kind: 'asr', pot: 'automatic' }));
    await rememberCaptionRequest(timedtext({ pot: 'manual' }));
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON3));

    const preferred = await transcriptFromObserved(VIDEO, undefined, new Set(), fetcher);
    expect(preferred?.cues.map((cue) => cue.text)).toEqual(['Hello there.']);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('pot=manual');

    await transcriptFromObserved(VIDEO, 'a.en', new Set(), fetcher);
    expect(String(fetcher.mock.calls[1]?.[0])).toContain('pot=automatic');
    expect(String(fetcher.mock.calls[1]?.[0])).toContain('fmt=json3');
    await expect(
      transcriptFromObserved('otherVideo1', undefined, new Set(), fetcher),
    ).resolves.toBeUndefined();
  });

  it('keeps the latest URL per track and tries each URL only once in a read', async () => {
    await rememberCaptionRequest(timedtext({ kind: 'asr', pot: 'old' }));
    await rememberCaptionRequest(timedtext({ kind: 'asr', pot: 'new' }));
    const empty = vi.fn<typeof fetch>(async () => new Response(''));
    const tried = new Set<string>();
    await expect(transcriptFromObserved(VIDEO, 'a.en', tried, empty)).resolves.toBeUndefined();
    await expect(transcriptFromObserved(VIDEO, 'a.en', tried, empty)).resolves.toBeUndefined();
    expect(empty).toHaveBeenCalledTimes(1);
    expect(String(empty.mock.calls[0]?.[0])).toContain('pot=new');
  });
});

describe("racing the page's read against the player's URL", () => {
  const never = new Promise<string>(() => undefined);

  it('uses what the page read when the player offers nothing', async () => {
    await expect(
      withObservedCaptions(Promise.resolve('page'), async () => undefined, 1),
    ).resolves.toBe('page');
  });

  it("does not wait on a stuck page once the player's URL has produced captions", async () => {
    let checks = 0;
    await expect(
      withObservedCaptions(never, async () => (++checks >= 3 ? 'observed' : undefined), 1),
    ).resolves.toBe('observed');
  });

  it('recovers after the page gives up, and otherwise reports what the page said', async () => {
    let checks = 0;
    await expect(
      withObservedCaptions(
        Promise.reject(new Error('page failed')),
        async () => (++checks >= 2 ? 'late' : undefined),
        1,
      ),
    ).resolves.toBe('late');
    await expect(
      withObservedCaptions(Promise.reject(new Error('page failed')), async () => undefined, 1),
    ).rejects.toThrow('page failed');
  });
});
