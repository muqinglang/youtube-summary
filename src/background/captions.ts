import { parseTranscript } from '../core/transcript';
import type { Transcript } from '../shared/types';

/**
 * YouTube withholds most automatic captions from any request without a proof-of-origin token that
 * only its own player attaches: the same URL fetched without it answers 200 with an empty body. The
 * worker sees every request the browser makes, the player's included, whichever tab or frame it
 * comes from. So it keeps the caption URLs the player used and can fetch one again itself, without
 * the page having to catch the response, which is the step that used to fail.
 */
const STORE_KEY = 'captions:observed';
const MAX_ENTRIES = 24;
const MAX_BYTES = 10_000_000;
const FETCH_TIMEOUT_MS = 10_000;
const CAPTION_URLS = [
  'https://www.youtube.com/api/timedtext*',
  'https://m.youtube.com/api/timedtext*',
];

interface ObservedCaption {
  videoId: string;
  language: string;
  automatic: boolean;
  name: string;
  url: string;
}

/** A request worth keeping: YouTube's own, for one video's untranslated track, with the token. */
export function observedCaption(raw: string): ObservedCaption | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const videoId = url.searchParams.get('v') ?? '';
  const language = url.searchParams.get('lang') ?? '';
  if (
    url.protocol !== 'https:' ||
    !['www.youtube.com', 'm.youtube.com'].includes(url.hostname) ||
    url.pathname !== '/api/timedtext' ||
    !/^[\w-]{11}$/.test(videoId) ||
    !/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(language) ||
    // Without the token the page can fetch the URL itself, and does; a translation is not the track.
    !url.searchParams.get('pot') ||
    url.searchParams.has('tlang')
  )
    return undefined;
  return {
    videoId,
    language,
    automatic: url.searchParams.get('kind') === 'asr',
    name: url.searchParams.get('name') ?? '',
    url: url.href,
  };
}

async function readObserved(): Promise<ObservedCaption[]> {
  const stored: unknown = (await chrome.storage.session.get(STORE_KEY))[STORE_KEY];
  return Array.isArray(stored) ? (stored as ObservedCaption[]) : [];
}

export async function rememberCaptionRequest(raw: string): Promise<void> {
  const caption = observedCaption(raw);
  if (!caption) return;
  const sameTrack = (entry: ObservedCaption) =>
    entry.videoId === caption.videoId &&
    entry.language === caption.language &&
    entry.automatic === caption.automatic &&
    entry.name === caption.name;
  // ponytail: read-modify-write, so two requests landing together can drop one; the player asks
  // again on the next read, which is when it matters.
  const entries = (await readObserved()).filter((entry) => !sameTrack(entry));
  await chrome.storage.session.set({ [STORE_KEY]: [...entries, caption].slice(-MAX_ENTRIES) });
}

/** Registered at the top of the worker, so a request wakes it and nothing is missed while asleep. */
export function observeCaptionRequests(): void {
  // Absent only where the permission is, which is a test harness rather than the extension.
  if (!('webRequest' in chrome)) return;
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      void rememberCaptionRequest(details.url).catch(() => undefined);
      return undefined;
    },
    { urls: CAPTION_URLS },
  );
}

/**
 * Captions for a video from a URL its player used. A vss id such as "a.en" names the track; without
 * one a person's captions are preferred over automatic ones, as the page itself does. Each URL is
 * tried once per read, so an expired one cannot be fetched over and over.
 */
export async function transcriptFromObserved(
  videoId: string,
  trackId: string | undefined,
  tried: Set<string>,
  fetcher: typeof fetch = fetch,
): Promise<Transcript | undefined> {
  const wanted = trackId ? /^(a?)\.([\w-]+)/.exec(trackId) : null;
  const candidates = (await readObserved())
    .filter(
      (entry) =>
        entry.videoId === videoId &&
        !tried.has(entry.url) &&
        (!wanted ||
          (entry.automatic === (wanted[1] === 'a') &&
            entry.language.toLowerCase() === wanted[2]!.toLowerCase())),
    )
    .reverse();
  const entry = candidates.find((candidate) => !candidate.automatic) ?? candidates[0];
  if (!entry) return undefined;
  tried.add(entry.url);
  const url = new URL(entry.url);
  url.searchParams.set('fmt', 'json3');
  const response = await fetcher(url.href, {
    credentials: 'include',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) return undefined;
  const raw = await response.text();
  if (!raw.trim() || raw.length > MAX_BYTES) return undefined;
  return {
    videoId,
    language: entry.language,
    source: 'youtube',
    coverage: 'complete',
    cues: parseTranscript(raw),
  };
}

/**
 * Runs the page's own read while checking for captions the player's URL can provide. Whichever has
 * them first is used, and the page's error stands only when both came up empty: neither route has
 * to succeed alone, which is what makes reading captions dependable.
 */
export async function withObservedCaptions<T>(
  page: Promise<T>,
  observed: () => Promise<T | undefined>,
  intervalMs = 1_000,
): Promise<T> {
  const outcome: { result?: { ok: true; value: T } | { ok: false; error: unknown } } = {};
  const settled = page.then(
    (value) => {
      outcome.result = { ok: true, value };
    },
    (error: unknown) => {
      outcome.result = { ok: false, error };
    },
  );
  for (;;) {
    const result = outcome.result;
    if (result?.ok) return result.value;
    const found = await observed().catch(() => undefined);
    if (found) return found;
    if (result) throw result.error;
    await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, intervalMs))]);
  }
}
