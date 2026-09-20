import type { Cue } from '../shared/types';

/**
 * Cloud translation the way the established bilingual-subtitle extensions do it: Google's own
 * public web endpoints, no key of the user's and no on-device model download.
 *
 * A whole video goes through the widget endpoint, which takes a list of strings and answers with
 * one translation per string, in order — four requests for a long video instead of a thousand.
 * The one-sentence-at-a-time endpoint stays as the fallback for a group it refuses.
 */
const BATCH_ENDPOINT = 'https://translate-pa.googleapis.com/v1/translateHtml';
/** Ships in Google's public translate widget: it identifies that widget, not any user. */
const BATCH_KEY = 'AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520';
/** Verified answering in order at 300 strings / 38 KB; these leave room to spare. */
const BATCH_SIZE = 100;
const BATCH_CHARS = 12_000;
const BATCH_TIMEOUT_MS = 30_000;
const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const POOL = 6;
/**
 * The free endpoint fails a request now and then with a 5xx or a rate limit, so such a glitch is
 * retried after these pauses before it counts as a failure.
 */
const RETRY_DELAYS_MS = [500, 1500];
/**
 * A request that never answers is worse than one that fails: nothing aborts it, so the translator
 * keeps its slot and the panel sits on 翻译中 for the rest of the session. Give up and retry instead.
 */
const REQUEST_TIMEOUT_MS = 15_000;

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

/** One call with its own deadline, so a request that never answers cannot hold up the queue. */
async function request(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
    });
    if (!response.ok)
      throw new TranslateError(
        response.status === 429
          ? 'Google 翻译请求过于频繁，请稍后再试，或切换「AI 字幕」。'
          : `Google 翻译失败（HTTP ${response.status}），请重试或切换「AI 字幕」。`,
        response.status === 429 || response.status >= 500,
      );
    return await response.json();
  } catch (error) {
    // Our own deadline, not the caller's cancellation: a failure worth retrying, never a hang.
    if (expired && !signal.aborted)
      throw new TranslateError('Google 翻译请求超时，请重试或切换「AI 字幕」。', true);
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/** The widget endpoint translates HTML, so text that looks like markup has to arrive as text. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function unescapeHtml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** One request for a whole group of sentences, answered in the order they were sent. */
async function translateBatch(texts: string[], tl: string, signal: AbortSignal): Promise<string[]> {
  const data = await request(
    BATCH_ENDPOINT,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json+protobuf', 'X-Goog-API-Key': BATCH_KEY },
      body: JSON.stringify([[texts.map(escapeHtml), 'auto', tl], 'te_lib']),
    },
    BATCH_TIMEOUT_MS,
    signal,
  );
  const translated: unknown = Array.isArray(data) ? data[0] : undefined;
  // A short or ragged answer cannot be matched back to its sentences; the caller falls back.
  if (
    !Array.isArray(translated) ||
    translated.length !== texts.length ||
    translated.some((item) => typeof item !== 'string' || !item.trim())
  )
    throw new TranslateError('Google 批量翻译返回了不完整的结果。', false);
  return translated.map((item) => unescapeHtml(String(item)).trim());
}

/** Sentences grouped into what one batch request carries. */
function groups(cues: Cue[]): Cue[][] {
  const batches: Cue[][] = [];
  let batch: Cue[] = [];
  let chars = 0;
  for (const cue of cues) {
    if (batch.length >= BATCH_SIZE || (batch.length && chars + cue.text.length > BATCH_CHARS)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(cue);
    chars += cue.text.length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/** One word as a dictionary has it: no model involved, so it is on screen in a moment. */
export interface WordEntry {
  translation: string;
  /** A rough pronunciation of the source word, when the endpoint knows one. */
  phonetic: string;
  senses: { pos: string; glosses: string[] }[];
}

/** The endpoint names them in full; a dictionary card wants the short form. */
const POS_LABELS: Record<string, string> = {
  noun: 'n.',
  verb: 'v.',
  adjective: 'adj.',
  adverb: 'adv.',
  pronoun: 'pron.',
  preposition: 'prep.',
  conjunction: 'conj.',
  interjection: 'int.',
  determiner: 'det.',
  article: 'art.',
  numeral: 'num.',
  abbreviation: 'abbr.',
  prefix: 'pref.',
  suffix: 'suf.',
  exclamation: 'excl.',
};

function textAt(value: unknown, index: number): string {
  return Array.isArray(value) && typeof value[index] === 'string' ? value[index] : '';
}

/**
 * The same endpoint the subtitles go through also carries a dictionary: `bd` is the entry, `rm`
 * the pronunciation. It answers in a fraction of the time a model takes to write the same thing,
 * and what it says about a word does not depend on the sentence the word was in.
 */
export async function lookupWord(
  word: string,
  language: string,
  signal: AbortSignal,
): Promise<WordEntry> {
  const url =
    `${ENDPOINT}?client=gtx&sl=auto&tl=${encodeURIComponent(targetCode(language))}` +
    `&dt=t&dt=bd&dt=rm&q=${encodeURIComponent(word.slice(0, 80))}`;
  const data = await request(url, {}, REQUEST_TIMEOUT_MS, signal);
  const segments: unknown[] = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : [];
  const translation = segments
    .map((segment) => textAt(segment, 0))
    .join('')
    .trim();
  // The transliteration rides in a trailing segment, in the slot after the target's own.
  const phonetic = segments.map((segment) => textAt(segment, 3)).find(Boolean) ?? '';
  const entries: unknown[] =
    Array.isArray(data) && Array.isArray((data as unknown[])[1]) ? ((data as unknown[])[1] as unknown[]) : [];
  const senses = entries.flatMap((entry) => {
    const pos = textAt(entry, 0).toLowerCase();
    const raw = Array.isArray(entry) ? entry[1] : undefined;
    const glosses = Array.isArray(raw)
      ? raw.filter((item): item is string => typeof item === 'string').slice(0, 6)
      : [];
    return glosses.length ? [{ pos: POS_LABELS[pos] ?? pos, glosses }] : [];
  });
  if (!translation && !senses.length) throw new TranslateError('没有查到这个词。', false);
  return { translation, phonetic: phonetic.trim(), senses: senses.slice(0, 5) };
}

async function requestOnce(text: string, tl: string, signal: AbortSignal): Promise<string> {
  const url =
    `${ENDPOINT}?client=gtx&sl=auto&dt=t&tl=${encodeURIComponent(tl)}` +
    `&q=${encodeURIComponent(text.slice(0, 4000))}`;
  const data = await request(url, {}, REQUEST_TIMEOUT_MS, signal);
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

interface Attempted {
  translations: Record<string, string>;
  failed: string[];
  lastError?: unknown;
}

/** One sentence per request, concurrently: the fallback for a group the batch endpoint refused. */
async function translateEach(cues: Cue[], tl: string, signal: AbortSignal): Promise<Attempted> {
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
  return { translations, failed, lastError };
}

/**
 * Translates cues keyed by cue id. A cue that still fails after its retries is listed in `failed`
 * and the others are kept. Only a run where nothing got through, for a reason a retry could have
 * fixed, throws: that is the endpoint failing, not one sentence.
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
  for (const group of groups(cues)) {
    if (signal.aborted) throw new DOMException('已取消', 'AbortError');
    try {
      const batch = await translateBatch(
        group.map((cue) => cue.text),
        tl,
        signal,
      );
      group.forEach((cue, index) => (translations[cue.id] = batch[index]!));
      continue;
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error;
    }
    const single = await translateEach(group, tl, signal);
    Object.assign(translations, single.translations);
    failed.push(...single.failed);
    if (single.lastError) lastError = single.lastError;
  }
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
