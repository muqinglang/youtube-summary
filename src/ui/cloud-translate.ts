import type { Cue } from '../shared/types';

/** Trancy-style cloud translation: Google's public web endpoint. No on-device model download. */
const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const POOL = 6;
/**
 * The free endpoint fails a request now and then with a 5xx or a rate limit. Asked one sentence at a
 * time, a long video is thousands of requests, so such a glitch is retried after these pauses
 * before it counts as a failure.
 */
const RETRY_DELAYS_MS = [500, 1500];

const LANGUAGES: Record<string, string> = {
  简体中文: 'zh-CN',
  English: 'en',
  日本語: 'ja',
  한국어: 'ko',
  Español: 'es',
  Français: 'fr',
  Deutsch: 'de',
  Português: 'pt',
  العربية: 'ar',
  हिन्दी: 'hi',
};

function targetCode(language: string): string {
  const text = language.trim();
  if (Object.hasOwn(LANGUAGES, text)) return LANGUAGES[text]!;
  try {
    const locale = new Intl.Locale(text);
    if (locale.language === 'zh')
      return locale.script === 'Hant' || /^(TW|HK|MO)$/.test(locale.region ?? '')
        ? 'zh-TW'
        : 'zh-CN';
    return locale.language === 'und' ? 'en' : locale.language;
  } catch {
    return 'en';
  }
}

/** A failed request, and whether asking again could succeed. */
class TranslateError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
  }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('已取消', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function requestOnce(text: string, tl: string, signal: AbortSignal): Promise<string> {
  const url =
    `${ENDPOINT}?client=gtx&sl=auto&dt=t&tl=${encodeURIComponent(tl)}` +
    `&q=${encodeURIComponent(text.slice(0, 4000))}`;
  const response = await fetch(url, { signal, credentials: 'omit', cache: 'no-store' });
  if (!response.ok)
    throw new TranslateError(
      response.status === 429
        ? 'Google 翻译请求过于频繁，请稍后再试，或切换「AI 字幕」。'
        : `Google 翻译失败（HTTP ${response.status}），请重试或切换「AI 字幕」。`,
      response.status === 429 || response.status >= 500,
    );
  const data: unknown = await response.json();
  const segments = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : [];
  const output = segments
    .map((segment) => (Array.isArray(segment) ? String(segment[0] ?? '') : ''))
    .join('');
  if (!output.trim()) throw new TranslateError('Google 翻译返回了空结果，请重试。', false);
  return output.trim();
}

async function translateOne(text: string, tl: string, signal: AbortSignal): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requestOnce(text, tl, signal);
    } catch (error) {
      // A dropped connection or a garbled body is not a TranslateError, and is worth another try.
      const transient = !(error instanceof TranslateError) || error.transient;
      if (signal.aborted || !transient || attempt >= RETRY_DELAYS_MS.length) throw error;
      await pause(RETRY_DELAYS_MS[attempt]!, signal);
    }
  }
}

/**
 * Translates cues concurrently, keyed by cue id. A cue that still fails after its retries is listed
 * in `failed` and the others are kept. Only a batch where nothing got through, for a reason a retry
 * could have fixed, throws: that is the endpoint failing, not one sentence.
 */
export async function translateCuesCloud(
  cues: Cue[],
  language: string,
  signal: AbortSignal,
): Promise<{ translations: Record<string, string>; failed: string[] }> {
  const tl = targetCode(language);
  const translations: Record<string, string> = Object.create(null) as Record<string, string>;
  const failed: string[] = [];
  let lastError: unknown;
  let next = 0;
  async function worker(): Promise<void> {
    while (next < cues.length) {
      if (signal.aborted) throw new DOMException('已取消', 'AbortError');
      const cue = cues[next++];
      if (!cue) continue;
      try {
        translations[cue.id] = await translateOne(cue.text, tl, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        failed.push(cue.id);
        lastError = error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(POOL, cues.length) }, () => worker()));
  const endpointFailing =
    failed.length > 0 &&
    failed.length === cues.length &&
    !(lastError instanceof TranslateError && !lastError.transient);
  if (endpointFailing)
    throw lastError instanceof Error
      ? lastError
      : new Error('Google 翻译失败，请重试或切换「AI 字幕」。');
  return { translations, failed };
}
