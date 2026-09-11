import { describe, expect, it } from 'vitest';
import type { CapturedCaption } from '../../src/content/caption-capture';
import { captionsViaPlayer, type CaptionPlayer } from '../../src/content/player-captions';

const VIDEO = 'dQw4w9WgXcQ';
const CAPTION: CapturedCaption = {
  videoId: VIDEO,
  language: 'en',
  raw: '{"events":[]}',
  coverage: 'unknown',
};
const AUTO = { id: 'a.en', language: 'en', automatic: true };
type Capture = Parameters<typeof captionsViaPlayer>[1];

/** Records every call the code under test makes on the player. */
function fakePlayer(showing: unknown = {}) {
  const calls: unknown[][] = [];
  const player: CaptionPlayer = {
    loadModule: (name) => void calls.push(['loadModule', name]),
    unloadModule: (name) => void calls.push(['unloadModule', name]),
    getOption: () => showing,
    setOption: (...args) => void calls.push(['setOption', ...args]),
  };
  return { player, calls };
}

/** Empty until the player has been asked for the track, as the real capture is; then it fills. */
function captureAfterRequest(calls: unknown[][], polls = 2): Capture {
  let seen = 0;
  return {
    get: () =>
      calls.some((call) => call[0] === 'setOption') && ++seen > polls ? CAPTION : undefined,
  };
}

const read = (player: CaptionPlayer | null, capture: Capture, track = AUTO, waitMs = 1_000) =>
  captionsViaPlayer(player, capture, VIDEO, track, new AbortController().signal, {
    waitMs,
    pollMs: 1,
  });

describe('reading captions through the page player', () => {
  it('asks the player for the track, returns what capture records, then switches captions off', async () => {
    const { player, calls } = fakePlayer({});
    expect(await read(player, captureAfterRequest(calls))).toBe(CAPTION);
    expect(calls).toEqual([
      ['loadModule', 'captions'],
      ['setOption', 'captions', 'track', { languageCode: 'en', kind: 'asr' }],
      // The viewer had captions off; reading a transcript must not leave them on.
      ['unloadModule', 'captions'],
    ]);
  });

  it('puts back the track the viewer was already watching', async () => {
    const theirs = { languageCode: 'fr', vssId: '.fr' };
    const { player, calls } = fakePlayer(theirs);
    await read(player, captureAfterRequest(calls));
    expect(calls.at(-1)).toEqual(['setOption', 'captions', 'track', theirs]);
    expect(calls.some((call) => call[0] === 'unloadModule')).toBe(false);
  });

  it('asks for a manual track without the automatic-captions kind', async () => {
    const { player, calls } = fakePlayer({});
    await read(player, captureAfterRequest(calls), { id: '.en', language: 'en', automatic: false });
    expect(calls[1]).toEqual(['setOption', 'captions', 'track', { languageCode: 'en' }]);
  });

  it('gives up after the wait and still restores, leaving the DOM fallback to run', async () => {
    const { player, calls } = fakePlayer({});
    expect(await read(player, { get: () => undefined }, AUTO, 20)).toBeUndefined();
    expect(calls.at(-1)).toEqual(['unloadModule', 'captions']);
  });

  it('does nothing on a page whose player has no caption API', async () => {
    expect(await read({}, { get: () => CAPTION })).toBeUndefined();
    expect(await read(null, { get: () => CAPTION })).toBeUndefined();
  });

  it('turns a throwing player into a miss instead of failing the whole read', async () => {
    const player: CaptionPlayer = {
      loadModule: () => {
        throw new Error('player not ready');
      },
      setOption: () => undefined,
    };
    expect(await read(player, { get: () => CAPTION })).toBeUndefined();
  });
});
