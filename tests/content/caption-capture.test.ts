import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installCaptionCapture, type CaptionCapture } from '../../src/content/caption-capture';

const VIDEO = 'dQw4w9WgXcQ';
const OTHER = 'abcdefghijk';
const json = (text = 'A complete caption response') =>
  JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: text }] }] });
const timedtext = (language = 'en', query = '') =>
  `https://www.youtube.com/api/timedtext?v=${VIDEO}&lang=${language}${query}`;

class FakeXHR extends EventTarget {
  status = 200;
  responseType: XMLHttpRequestResponseType = '';
  responseText = '';
  response: unknown = null;
  responseXML: Document | null = null;
  responseURL = '';
  contentLength: string | null = null;
  calls: unknown[][] = [];
  openError: Error | undefined;
  open(...args: unknown[]): void {
    if (this.openError) throw this.openError;
    this.calls.push(args);
    this.responseURL = new URL(String(args[1]), location.href).href;
  }
  getResponseHeader(name: string): string | null {
    return name === 'content-length' ? this.contentLength : null;
  }
  complete() {
    this.dispatchEvent(new Event('loadend'));
  }
}
const nativeOpen = FakeXHR.prototype.open;

let currentVideo: string | null;
let nativeFetch: ReturnType<typeof vi.fn<typeof fetch>>;
let capture: CaptionCapture;
let notify: ReturnType<typeof vi.fn>;
let fakeWindow: Window;
let fakeDocument: Document;

beforeEach(() => {
  currentVideo = VIDEO;
  nativeFetch = vi.fn<typeof fetch>();
  notify = vi.fn();
  fakeWindow = Object.assign(new EventTarget(), {
    fetch: nativeFetch,
    XMLHttpRequest: FakeXHR,
  }) as unknown as Window;
  fakeDocument = new EventTarget() as unknown as Document;
  vi.stubGlobal('window', fakeWindow);
  vi.stubGlobal('document', fakeDocument);
  vi.stubGlobal('location', new URL(`https://www.youtube.com/watch?v=${VIDEO}`));
  capture = installCaptionCapture({ getVideoId: () => currentVideo, onAvailable: notify });
});
afterEach(() => {
  capture.dispose();
  FakeXHR.prototype.open = nativeOpen;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function observeFetch(
  raw: string,
  url = timedtext(),
  status = 200,
  headers: HeadersInit = {},
) {
  const response = new Response(raw, { status, headers });
  Object.defineProperty(response, 'url', { value: url });
  const copies: Response[] = [];
  const clone = vi.spyOn(response, 'clone').mockImplementation(() => {
    const copy = Response.prototype.clone.call(response);
    copies.push(copy);
    return copy;
  });
  const nativePromise = Promise.resolve(response);
  nativeFetch.mockReturnValueOnce(nativePromise);
  const result = fakeWindow.fetch(url);
  expect(result).toBe(nativePromise);
  expect(await result).toBe(response);
  if (copies.length) await vi.waitFor(() => expect(copies[0]!.body!.locked).toBe(false));
  return { response, clone };
}

describe('passive fetch capture', () => {
  it('preserves this, every argument, original promise, response and unconsumed body', async () => {
    const response = new Response(json());
    const promise = Promise.resolve(response);
    nativeFetch.mockReturnValueOnce(promise);
    const url = timedtext('en', '&fmt=srv3&pot=opaque-native-parameter');
    const options: RequestInit = { credentials: 'include', headers: { 'x-native': 'unchanged' } };
    const receiver = { caller: 'native-page' };
    const returned = fakeWindow.fetch.call(receiver, url, options);
    expect(returned).toBe(promise);
    expect(nativeFetch.mock.contexts[0]).toBe(receiver);
    expect(nativeFetch).toHaveBeenCalledExactlyOnceWith(url, options);
    await vi.waitFor(() => expect(capture.get(VIDEO)?.raw).toBe(json()));
    expect(await response.text()).toBe(json());
    expect(notify).toHaveBeenCalledExactlyOnceWith({
      videoId: VIDEO,
      language: 'en',
      raw: json(),
      coverage: 'unknown',
    });
  });

  it.each(['request', 'url', 'relative'])(
    'accepts %s inputs without changing them',
    async (kind) => {
      const input =
        kind === 'request'
          ? new Request(timedtext())
          : kind === 'url'
            ? new URL(timedtext())
            : `/api/timedtext?v=${VIDEO}&lang=en`;
      nativeFetch.mockResolvedValueOnce(new Response(json()));
      await fakeWindow.fetch(input);
      await vi.waitFor(() => expect(capture.get(VIDEO)).toBeDefined());
      expect(nativeFetch).toHaveBeenCalledExactlyOnceWith(input);
    },
  );

  it.each([
    'https://example.com/api/timedtext',
    'https://www.youtube.com/api/other',
    'https://www.youtube.com.evil.example/api/timedtext',
    'http://www.youtube.com/api/timedtext',
    'https://www.youtube.com:8443/api/timedtext',
    'https://user:password@www.youtube.com/api/timedtext',
  ])('never clones or reads unrelated response %s', async (base) => {
    const { clone } = await observeFetch(json(), `${base}?v=${VIDEO}&lang=en`);
    expect(clone).not.toHaveBeenCalled();
    expect(capture.get(VIDEO)).toBeUndefined();
  });

  it('excludes translated and other-video captions without altering the request', async () => {
    for (const url of [
      timedtext('en', '&tlang=zh-Hans'),
      timedtext('en', '&tlang='),
      timedtext().replace(VIDEO, OTHER),
    ]) {
      const { clone } = await observeFetch(json(), url);
      expect(clone).not.toHaveBeenCalled();
      expect(nativeFetch).toHaveBeenLastCalledWith(url);
    }
    expect(notify).not.toHaveBeenCalled();
  });

  it.each(['youtube.com', 'm.youtube.com'])(
    'accepts supported YouTube host %s and arbitrary fmt',
    async (host) => {
      await observeFetch(
        '<transcript><text start="0" dur="2">完整的原生字幕</text></transcript>',
        timedtext('zh-Hans', '&fmt=srv1').replace('www.youtube.com', host),
      );
      expect(capture.get(VIDEO, { language: 'zh-Hans' })?.raw).toContain('完整的原生字幕');
    },
  );

  it.each([
    '',
    '<html><body>blocked</body></html>',
    '{"error":"unavailable"}',
    '{"events":[]}',
    '{"events":[{"tStartMs":0}]}',
  ])('rejects an empty/error response %s', async (body) => {
    await observeFetch(body);
    expect(capture.get(VIDEO)).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not clone HTTP failures or declared oversized responses', async () => {
    const failure = await observeFetch(json(), timedtext(), 403);
    const oversized = await observeFetch(json(), timedtext(), 200, {
      'content-length': '10000001',
    });
    expect(failure.clone).not.toHaveBeenCalled();
    expect(oversized.clone).not.toHaveBeenCalled();
    expect(capture.get(VIDEO)).toBeUndefined();
  });

  it('cancels only an oversized clone stream while the caller still reads the original response', async () => {
    const body = 'x'.repeat(10_000_001);
    const { response } = await observeFetch(body);
    expect(capture.get(VIDEO)).toBeUndefined();
    expect((await response.text()).length).toBe(body.length);
  });

  it('keeps native rejections and synchronous throws unchanged', async () => {
    const failure = new Error('native failure');
    const rejected = Promise.reject(failure);
    nativeFetch.mockReturnValueOnce(rejected);
    expect(fakeWindow.fetch(timedtext())).toBe(rejected);
    await expect(rejected).rejects.toBe(failure);
    nativeFetch.mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => fakeWindow.fetch(timedtext())).toThrow(failure);
  });

  it('isolates callback exceptions from the native request', async () => {
    notify.mockImplementation(() => {
      throw new Error('observer callback failed');
    });
    const { response } = await observeFetch(json());
    expect(await response.text()).toBe(json());
    expect(capture.get(VIDEO)).toBeDefined();
  });
});

describe('track and lifetime limits', () => {
  it('distinguishes source/manual tracks and prefers manual captions when no track is requested', async () => {
    await observeFetch(json('manual'), timedtext());
    await observeFetch(json('automatic'), timedtext('en', '&kind=asr'));
    expect(capture.get(VIDEO)?.raw).toBe(json('manual'));
    expect(capture.get(VIDEO, { language: 'en', automatic: true, id: 'a.en' })?.raw).toBe(
      json('automatic'),
    );
    expect(capture.get(VIDEO, { language: 'en', automatic: false, id: '.en' })?.raw).toBe(
      json('manual'),
    );
    expect(capture.get(VIDEO, { language: 'fr' })).toBeUndefined();
  });

  it('keeps at most four tracks and never exposes mutable cache entries', async () => {
    for (const language of ['en', 'fr', 'de', 'ja', 'ko'])
      await observeFetch(json(language), timedtext(language));
    expect(capture.get(VIDEO, { language: 'en' })).toBeUndefined();
    const returned = capture.get(VIDEO, { language: 'ko' })!;
    returned.raw = 'modified outside observer';
    expect(capture.get(VIDEO, { language: 'ko' })?.raw).toBe(json('ko'));
    expect(notify).toHaveBeenCalledTimes(5);
  });

  it('bounds total retained UTF-8 bytes, rather than only JavaScript string length', async () => {
    const large = JSON.stringify({
      events: Array.from({ length: 15 }, (_, index) => ({
        tStartMs: index * 2000,
        dDurationMs: 1000,
        segs: [{ utf8: '字'.repeat(85_000) }],
      })),
    });
    expect(new TextEncoder().encode(large).byteLength).toBeGreaterThan(3_500_000);
    for (const language of ['en', 'fr', 'de']) await observeFetch(large, timedtext(language));
    expect(capture.get(VIDEO, { language: 'en' })).toBeUndefined();
    expect(capture.get(VIDEO, { language: 'fr' })).toBeDefined();
    expect(capture.get(VIDEO, { language: 'de' })).toBeDefined();
  });

  it('does not notify twice for identical native responses', async () => {
    await observeFetch(json());
    await observeFetch(json());
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('invalidates cached captions on video changes and rejects old in-flight responses', async () => {
    await observeFetch(json());
    let finish: (response: Response) => void = () => {};
    nativeFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = fakeWindow.fetch(timedtext('fr'));
    currentVideo = OTHER;
    expect(capture.get(VIDEO)).toBeUndefined();
    finish(new Response(json('stale')));
    await pending;
    currentVideo = VIDEO;
    expect(capture.get(VIDEO)).toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('invalidates cache at YouTube navigation start even before location changes', async () => {
    await observeFetch(json());
    fakeDocument.dispatchEvent(new Event('yt-navigate-start'));
    expect(capture.get(VIDEO)).toBeUndefined();
  });

  it('restores its own wrappers but never overwrites wrappers installed later by other extensions', () => {
    const capturedFetch = fakeWindow.fetch;
    const capturedOpen = FakeXHR.prototype.open;
    const laterFetch = new Proxy(capturedFetch, {});
    const laterOpen = new Proxy(capturedOpen, {});
    fakeWindow.fetch = laterFetch;
    FakeXHR.prototype.open = laterOpen;
    capture.dispose();
    expect(fakeWindow.fetch).toBe(laterFetch);
    expect(FakeXHR.prototype.open).toBe(laterOpen);
    expect(capture.get(VIDEO)).toBeUndefined();
    FakeXHR.prototype.open = capturedOpen; // Reset the test class; disposing wrapper becomes inert.
  });
});

describe('passive XHR capture', () => {
  it('preserves open overload arguments and records successful text responses', async () => {
    const xhr = new FakeXHR();
    const url = timedtext('en', '&fmt=json3&pot=opaque-native-parameter');
    xhr.open('GET', url, false, 'native-user', 'native-password');
    expect(xhr.calls).toEqual([['GET', url, false, 'native-user', 'native-password']]);
    xhr.responseText = json();
    xhr.complete();
    await vi.waitFor(() => expect(capture.get(VIDEO)?.raw).toBe(json()));
    expect(xhr.responseText).toBe(json());
  });

  it('supports the two-argument open overload and JSON responseType', async () => {
    const xhr = new FakeXHR();
    xhr.open('GET', new URL(timedtext()));
    xhr.responseType = 'json';
    xhr.response = JSON.parse(json());
    xhr.complete();
    await vi.waitFor(() => expect(capture.get(VIDEO)?.raw).toBe(json()));
    expect(xhr.calls[0]).toHaveLength(2);
  });

  it('supports XML document responseType while keeping the original document', async () => {
    const xml = '<timedtext><body><p t="0" d="1000"><s>XML 字幕</s></p></body></timedtext>';
    const document = { xml } as unknown as Document;
    vi.stubGlobal(
      'XMLSerializer',
      class {
        serializeToString(value: Document) {
          expect(value).toBe(document);
          return xml;
        }
      },
    );
    const xhr = new FakeXHR();
    xhr.open('GET', timedtext('zh'));
    xhr.responseType = 'document';
    xhr.responseXML = document;
    xhr.complete();
    await vi.waitFor(() => expect(capture.get(VIDEO)?.raw).toBe(xml));
    expect(xhr.responseXML).toBe(document);
  });

  it('ignores translated/error responses and a reused XHR pointing at another request', async () => {
    const xhr = new FakeXHR();
    xhr.open('GET', timedtext());
    xhr.open('GET', timedtext('en', '&tlang=zh'));
    xhr.responseText = json('translated');
    xhr.complete();
    const failed = new FakeXHR();
    failed.open('GET', timedtext());
    failed.status = 403;
    failed.responseText = json('error');
    failed.complete();
    await Promise.resolve();
    expect(capture.get(VIDEO)).toBeUndefined();
  });

  it('cleans up failed requests so a later successful XHR can still be observed', async () => {
    for (let index = 0; index < 20; index++) {
      const failed = new FakeXHR();
      failed.open('GET', timedtext());
      failed.status = 0;
      failed.complete();
    }
    const xhr = new FakeXHR();
    xhr.open('GET', timedtext());
    xhr.responseText = json();
    xhr.complete();
    await vi.waitFor(() => expect(capture.get(VIDEO)).toBeDefined());
  });

  it('preserves synchronous native open exceptions', () => {
    const xhr = new FakeXHR();
    xhr.openError = new Error('native invalid state');
    expect(() => xhr.open('GET', timedtext())).toThrow(xhr.openError);
  });
});
