import { parseTranscript } from '../core/transcript';
import { videoIdFromUrl } from './protocol';

const MAX_BYTES = 10_000_000;
const MAX_TRACKS = 4;

export interface CapturedCaption {
  videoId: string;
  language: string;
  raw: string;
  coverage: 'unknown';
}

export interface CaptureTrack {
  language: string;
  automatic?: boolean;
  id?: string;
}

export interface CaptionCapture {
  get(videoId: string, track?: CaptureTrack): CapturedCaption | undefined;
  dispose(): void;
}

interface TrackRequest {
  videoId: string;
  language: string;
  automatic: boolean;
  id: string;
  key: string;
}

interface Entry extends TrackRequest {
  raw: string;
  bytes: number;
}

/** Observes completed native caption responses only. No request parameters, bodies or credentials are changed. */
export function installCaptionCapture(
  options: {
    onAvailable?: (caption: CapturedCaption) => void;
    getVideoId?: () => string | null;
  } = {},
): CaptionCapture {
  const getVideoId = options.getVideoId ?? (() => videoIdFromUrl(location.href));
  const cache = new Map<string, Entry>();
  const xhrListeners = new Map<XMLHttpRequest, EventListener>();
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  let activeVideoId: string | null = null;
  let epoch = 0;
  let bytesStored = 0;
  let disposed = false;
  let activeReads = 0;

  function clear() {
    cache.clear();
    bytesStored = 0;
    epoch++;
    for (const reader of readers) void reader.cancel().catch(() => {});
    readers.clear();
  }

  function currentVideoId(): string | null {
    let id: string | null;
    try {
      id = getVideoId();
    } catch {
      id = null;
    }
    if (id !== activeVideoId) {
      clear();
      activeVideoId = id;
    }
    return id;
  }

  function match(raw: string): TrackRequest | undefined {
    try {
      const url = new URL(raw, location.href);
      if (
        url.protocol !== 'https:' ||
        url.port ||
        url.username ||
        url.password ||
        !['www.youtube.com', 'm.youtube.com', 'youtube.com'].includes(url.hostname) ||
        url.pathname !== '/api/timedtext' ||
        url.searchParams.has('tlang')
      )
        return;
      const videoId = url.searchParams.get('v');
      const language = url.searchParams.get('lang') ?? '';
      if (
        !videoId ||
        videoId !== currentVideoId() ||
        !/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(language)
      )
        return;
      const automatic = url.searchParams.get('kind') === 'asr';
      const name = url.searchParams.get('name') ?? '';
      if (name.length > 500) return;
      const baseId = `${automatic ? 'a.' : '.'}${language}`;
      const suppliedId = url.searchParams.get('vssId');
      const id =
        suppliedId && suppliedId.length <= 200 ? suppliedId : `${baseId}${name ? `.${name}` : ''}`;
      return {
        videoId,
        language,
        automatic,
        id,
        key: `${language.toLowerCase()}\0${automatic}\0${name}`,
      };
    } catch {
      return;
    }
  }

  function exposed(entry: Entry): CapturedCaption {
    return {
      videoId: entry.videoId,
      language: entry.language,
      raw: entry.raw,
      coverage: 'unknown',
    };
  }

  function accept(track: TrackRequest, raw: string, started: number) {
    if (
      disposed ||
      track.videoId !== currentVideoId() ||
      started !== epoch ||
      !raw.trim() ||
      raw.length > MAX_BYTES
    )
      return;
    const bytes = new TextEncoder().encode(raw).byteLength;
    if (bytes > MAX_BYTES) return;
    try {
      parseTranscript(raw);
    } catch {
      return;
    } // Reject HTML/error JSON/empty event streams, not just empty strings.
    const previous = cache.get(track.key);
    if (previous?.raw === raw) return;
    if (previous) {
      cache.delete(track.key);
      bytesStored -= previous.bytes;
    }
    while (cache.size >= MAX_TRACKS || bytesStored + bytes > MAX_BYTES) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      bytesStored -= cache.get(oldest)!.bytes;
      cache.delete(oldest);
    }
    const entry = { ...track, raw, bytes };
    cache.set(track.key, entry);
    bytesStored += bytes;
    try {
      options.onAvailable?.(exposed(entry));
    } catch {
      /* Observer callbacks never fail native requests. */
    }
  }

  async function readResponse(response: Response, track: TrackRequest, started: number) {
    if (disposed || activeReads >= MAX_TRACKS || !response.ok || response.type === 'opaque') return;
    if (track.videoId !== currentVideoId() || started !== epoch) return;
    if (response.url) {
      const actual = match(response.url);
      if (!actual || actual.key !== track.key || actual.videoId !== track.videoId) return;
    }
    if (Number(response.headers.get('content-length')) > MAX_BYTES) return;
    const copy = response.clone();
    if (!copy.body) return;
    const reader = copy.body.getReader();
    activeReads++;
    readers.add(reader);
    let size = 0;
    let raw = '';
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (
          size > MAX_BYTES ||
          disposed ||
          started !== epoch ||
          track.videoId !== currentVideoId()
        ) {
          void reader.cancel().catch(() => {});
          return;
        }
        raw += decoder.decode(chunk.value, { stream: true });
      }
      raw += decoder.decode();
      accept(track, raw, started);
    } finally {
      readers.delete(reader);
      reader.releaseLock();
      activeReads--;
    }
  }

  const originalFetch = window.fetch;
  const wrappedFetch = new Proxy(originalFetch, {
    apply(target, thisArgument, argumentsList: Parameters<typeof fetch>) {
      const result = Reflect.apply(target, thisArgument, argumentsList) as ReturnType<typeof fetch>;
      try {
        const input = argumentsList[0];
        const raw =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input instanceof Request
                ? input.url
                : undefined;
        const track = raw && !disposed ? match(raw) : undefined;
        if (track) {
          const started = epoch;
          void Promise.resolve(result)
            .then((response) => readResponse(response, track, started))
            .catch(() => {});
        }
      } catch {
        /* Observation must preserve the original fetch result and rejection. */
      }
      return result;
    },
  });
  window.fetch = wrappedFetch;

  const xhrPrototype = window.XMLHttpRequest.prototype;
  const originalOpen = xhrPrototype.open;
  const wrappedOpen = new Proxy(originalOpen, {
    apply(target, xhr: XMLHttpRequest, argumentsList: unknown[]) {
      const result: unknown = Reflect.apply(target, xhr, argumentsList);
      try {
        const previous = xhrListeners.get(xhr);
        if (previous) {
          xhr.removeEventListener('loadend', previous);
          xhrListeners.delete(xhr);
        }
        const input = argumentsList[1];
        const raw =
          typeof input === 'string' ? input : input instanceof URL ? input.href : undefined;
        const track = raw && !disposed ? match(raw) : undefined;
        if (track && xhrListeners.size < 16) {
          const started = epoch;
          const listener: EventListener = () => {
            xhrListeners.delete(xhr);
            // A later wrapper or load handler may reuse the XHR. Check its response identity again.
            void Promise.resolve()
              .then(() => {
                if (disposed || xhr.status < 200 || xhr.status >= 300 || started !== epoch) return;
                const actual = xhr.responseURL ? match(xhr.responseURL) : track;
                if (!actual || actual.key !== track.key || actual.videoId !== track.videoId) return;
                if (Number(xhr.getResponseHeader('content-length')) > MAX_BYTES) return;
                let body: string;
                if (!xhr.responseType || xhr.responseType === 'text') body = xhr.responseText;
                else if (xhr.responseType === 'json') body = JSON.stringify(xhr.response) ?? '';
                else if (xhr.responseType === 'document' && xhr.responseXML)
                  body = new XMLSerializer().serializeToString(xhr.responseXML);
                else return;
                accept(track, body, started);
              })
              .catch(() => {});
          };
          xhrListeners.set(xhr, listener);
          xhr.addEventListener('loadend', listener, { once: true });
        }
      } catch {
        /* Keep every XHR.open overload, return value and exception unchanged. */
      }
      return result;
    },
  });
  xhrPrototype.open = wrappedOpen;

  document.addEventListener('yt-navigate-start', clear);
  window.addEventListener('popstate', clear);
  return {
    get(videoId, track) {
      if (disposed || videoId !== currentVideoId()) return;
      const candidates = [...cache.values()]
        .filter(
          (entry) =>
            !track ||
            (entry.language.toLowerCase() === track.language.toLowerCase() &&
              (track.automatic === undefined || entry.automatic === track.automatic)),
        )
        .reverse();
      let entry: Entry | undefined;
      if (track?.id)
        entry =
          candidates.find((candidate) => candidate.id === track.id) ??
          (candidates.length === 1 ? candidates[0] : undefined);
      else entry = candidates.find((candidate) => !candidate.automatic) ?? candidates[0];
      return entry ? exposed(entry) : undefined;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
      for (const [xhr, listener] of xhrListeners) xhr.removeEventListener('loadend', listener);
      xhrListeners.clear();
      document.removeEventListener('yt-navigate-start', clear);
      window.removeEventListener('popstate', clear);
      // Do not overwrite a wrapper installed by another extension after this one.
      if (window.fetch === wrappedFetch) window.fetch = originalFetch;
      if (xhrPrototype.open === wrappedOpen) xhrPrototype.open = originalOpen;
    },
  };
}
