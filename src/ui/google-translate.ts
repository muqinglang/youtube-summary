import type { PublicSettings, Transcript } from '../shared/types';

type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available';
type Progress = (completed: number, total: number, label: string) => void;
type DownloadMonitor = {
  addEventListener(type: 'downloadprogress', listener: (event: { loaded: number }) => void): void;
};
type CreateOptions = { signal: AbortSignal; monitor: (monitor: DownloadMonitor) => void };
type LanguagePair = { sourceLanguage: string; targetLanguage: string };
interface NativeSession {
  destroy(): void;
}
interface NativeTranslator extends NativeSession {
  translate(text: string, options: { signal: AbortSignal }): Promise<string>;
}
interface NativeDetector extends NativeSession {
  detect(
    text: string,
    options: { signal: AbortSignal },
  ): Promise<{ detectedLanguage: string; confidence: number }[]>;
}
interface TranslationWindow {
  Translator?: {
    availability(options: LanguagePair): Promise<Availability>;
    create(options: LanguagePair & CreateOptions): Promise<NativeTranslator>;
  };
  LanguageDetector?: {
    availability(): Promise<Availability>;
    create(options: CreateOptions): Promise<NativeDetector>;
  };
}

const LANGUAGES: Record<string, string> = {
  简体中文: 'zh',
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
const MAX_TEXT = 10 * 1024 * 1024;
const MODEL_TIMEOUT = 180_000;
const OPERATION_TIMEOUT = 25_000;
const JOB_TIMEOUT = 30 * 60_000;

class TranslationError extends Error {}

export function resolveTranslationEngine(
  settings: Pick<PublicSettings, 'hasApiKey' | 'model'> &
    Partial<Pick<PublicSettings, 'translationEngine'>>,
): 'google' | 'ai' {
  // Default to Google (instant, no key) like Trancy's "Default subtitles"; AI is opt-in.
  return settings.translationEngine === 'ai' ? 'ai' : 'google';
}

/** A user-opened web fallback for one selected cue, never a substitute for translated subtitles. */
export function googleTranslateUrl(text: string, language: string): string {
  const target = languageCode(language);
  if (!target) throw new TranslationError('目标语言无效，请重新选择翻译语言。');
  if (!text.trim()) throw new TranslationError('请先选择一条有文本的字幕。');
  const url = new URL('https://translate.google.com/');
  url.search = new URLSearchParams({
    sl: 'auto',
    tl: target,
    text: text.slice(0, 5_000),
    op: 'translate',
  }).toString();
  return url.href;
}

function languageCode(value: string): string | undefined {
  const text = value.trim();
  if (!text || /^(auto|und)$/i.test(text)) return undefined;
  if (Object.hasOwn(LANGUAGES, text)) return LANGUAGES[text];
  try {
    const locale = new Intl.Locale(text);
    if (locale.language === 'und') return undefined;
    if (locale.language === 'zh') {
      const traditional =
        locale.script === 'Hant' || (!locale.script && /^(TW|HK|MO)$/.test(locale.region ?? ''));
      return traditional ? 'zh-Hant' : 'zh';
    }
    return locale.language;
  } catch {
    return undefined;
  }
}

function destroy(session: NativeSession | undefined): void {
  try {
    session?.destroy();
  } catch {
    // Cleanup must not mask the original cancellation / translation error.
  }
}

function cancelled(): DOMException {
  return new DOMException('翻译已取消。', 'AbortError');
}

/** Native calls are abortable, but the deadline also protects against a stalled implementation. */
function operation<T>(
  action: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal,
  label: string,
  timeout: number,
  releaseLate?: (value: T) => void,
): Promise<T> {
  if (parent.aborted) return Promise.reject(cancelled());
  if (timeout <= 0)
    return Promise.reject(new TranslationError('本次翻译已超过 30 分钟，请重试剩余字幕。'));
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', abort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const stop = (error: Error) => {
      controller.abort(error);
      fail(error);
    };
    const abort = () => stop(cancelled());
    const timer = setTimeout(
      () => stop(new TranslationError(`${label}超时，请检查网络后重试，或切换 AI 翻译。`)),
      timeout,
    );
    parent.addEventListener('abort', abort, { once: true });
    try {
      action(controller.signal).then((value) => {
        if (settled) {
          releaseLate?.(value);
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      }, fail);
    } catch (error) {
      fail(error);
    }
  });
}

function requireAvailable(value: Availability, label: string): void {
  if (!['available', 'downloadable', 'downloading'].includes(value))
    throw new TranslationError(`${label}目前不可用，请选择其他字幕语言或切换 AI 翻译。`);
}

function nativeError(error: unknown, label: string): Error {
  if (error instanceof TranslationError) return error;
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError') return cancelled();
  if (name === 'NotAllowedError')
    return new TranslationError(
      '请再次点击「翻译字幕」以启用 Google 翻译。首次下载语言检测模型后，浏览器可能需要新的一次点击授权；若仍失败，请切换 AI 翻译。',
    );
  if (name === 'NotSupportedError')
    return new TranslationError(
      '当前浏览器或语言组合不支持 Google 本地翻译，请更换语言或切换 AI 翻译。',
    );
  if (name === 'QuotaExceededError')
    return new TranslationError(
      '单条字幕超出 Google 翻译模型容量，请拆分字幕后导入，或切换 AI 翻译。',
    );
  if (name === 'NetworkError')
    return new TranslationError(
      'Google 语言模型下载失败，请检查网络后再次点击翻译，或切换 AI 翻译。',
    );
  return new TranslationError(`${label}失败，请重试或切换 AI 翻译。`);
}

/** Uses only Chrome's official on-device APIs; no keys, remote endpoints, or cue resegmentation. */
export async function translateWithGoogle(
  transcript: Transcript,
  language: string,
  signal: AbortSignal,
  onProgress: Progress,
  onTranslation?: (cueId: string, text: string) => void,
): Promise<Record<string, string>> {
  if (signal.aborted) throw cancelled();
  const native = (typeof window === 'undefined' ? {} : window) as TranslationWindow;
  const targetLanguage = languageCode(language);
  if (!targetLanguage) throw new TranslationError('目标语言无效，请重新选择翻译语言。');
  const knownSource = languageCode(transcript.language);
  if (!native.Translator && knownSource !== targetLanguage)
    throw new TranslationError(
      '当前浏览器没有 Google 本地翻译 API，请使用支持此功能的桌面 Chrome 138 或更新版本，或切换 AI 翻译。',
    );
  const { cues } = transcript;
  if (!Array.isArray(cues) || !cues.length || cues.length > 100_000)
    throw new TranslationError('没有可翻译的字幕，或字幕超过 100,000 条。');
  let inputLength = 0;
  const ids = new Set<string>();
  for (const cue of cues) {
    if (
      !cue ||
      typeof cue.id !== 'string' ||
      !cue.id ||
      ids.has(cue.id) ||
      typeof cue.text !== 'string' ||
      !cue.text.trim()
    )
      throw new TranslationError('字幕包含重复编号或空文本，请重新加载字幕。');
    inputLength += cue.text.length;
    if (cue.text.length > 10_000 || inputLength > 2_000_000)
      throw new TranslationError('字幕文本过大，请拆分后导入。');
    ids.add(cue.id);
  }

  const deadline = Date.now() + JOB_TIMEOUT;
  const run = <T>(
    action: (signal: AbortSignal) => Promise<T>,
    label: string,
    timeout = OPERATION_TIMEOUT,
    late?: (value: T) => void,
  ) => operation(action, signal, label, Math.min(timeout, deadline - Date.now()), late);
  let active = true;
  const monitor = (label: string) => (target: DownloadMonitor) => {
    target.addEventListener('downloadprogress', (event) => {
      if (active && !signal.aborted && Number.isFinite(event.loaded))
        onProgress(
          0,
          cues.length,
          `${label} ${Math.round(Math.min(1, Math.max(0, event.loaded)) * 100)}%`,
        );
    });
  };
  let translator: NativeTranslator | undefined;
  let detector: NativeDetector | undefined;
  const release = () => {
    const sessions = [translator, detector];
    translator = undefined;
    detector = undefined;
    sessions.forEach(destroy);
  };
  signal.addEventListener('abort', release, { once: true });
  let stage = 'Google 翻译';
  try {
    let sourceLanguage = knownSource;
    if (!sourceLanguage) {
      stage = '字幕语言识别';
      const api = native.LanguageDetector;
      if (!api)
        throw new TranslationError(
          '当前浏览器无法自动识别字幕语言，请选择明确语言的 YouTube 字幕轨道，或切换 AI 翻译。',
        );
      onProgress(0, cues.length, '正在检查字幕语言识别模型');
      const availability = await run(() => api.availability(), stage);
      requireAvailable(availability, '字幕语言识别模型');
      const downloadLabel =
        availability === 'available'
          ? '正在加载字幕语言识别模型'
          : '首次使用，正在下载字幕语言识别模型';
      onProgress(0, cues.length, downloadLabel);
      detector = await run(
        (signal) => api.create({ signal, monitor: monitor(downloadLabel) }),
        stage,
        MODEL_TIMEOUT,
        destroy,
      );
      let sample = '';
      for (const cue of cues) {
        sample += `${cue.text.slice(0, 4_000 - sample.length)}\n`;
        if (sample.length >= 4_000) break;
      }
      const results = await run(
        (signal) => detector!.detect(sample.slice(0, 4_000), { signal }),
        stage,
      );
      const best = Array.isArray(results) ? results[0] : undefined;
      if (
        !best ||
        !Number.isFinite(best.confidence) ||
        best.confidence < 0.7 ||
        best.confidence > 1 ||
        !(sourceLanguage = languageCode(best.detectedLanguage))
      )
        throw new TranslationError(
          '无法可靠识别原字幕语言，请选择明确语言的 YouTube 字幕轨道，或切换 AI 翻译。',
        );
      const completedDetector = detector;
      detector = undefined;
      destroy(completedDetector);
    }

    stage = 'Google 翻译';
    const sameLanguage = sourceLanguage === targetLanguage;
    if (!sameLanguage) {
      const pair = { sourceLanguage, targetLanguage };
      onProgress(0, cues.length, '正在检查 Google 翻译语言包');
      const availability = await run(() => native.Translator!.availability(pair), stage);
      requireAvailable(availability, `Google 翻译 ${sourceLanguage} → ${targetLanguage}`);
      const downloadLabel =
        availability === 'available'
          ? '正在加载 Google 翻译语言包'
          : '首次使用，正在下载 Google 翻译语言包';
      onProgress(0, cues.length, downloadLabel);
      translator = await run(
        (signal) => native.Translator!.create({ ...pair, signal, monitor: monitor(downloadLabel) }),
        'Google 翻译语言包加载',
        MODEL_TIMEOUT,
        destroy,
      );
    }
    const translations: Record<string, string> = Object.create(null);
    let outputLength = 0;
    for (const [index, cue] of cues.entries()) {
      if (signal.aborted) throw cancelled();
      const output = sameLanguage
        ? cue.text
        : await run((signal) => translator!.translate(cue.text, { signal }), 'Google 字幕翻译');
      if (signal.aborted) throw cancelled();
      if (typeof output !== 'string' || !output.trim())
        throw new TranslationError(
          `Google 翻译未返回第 ${index + 1} 条字幕的有效译文，请重试或切换 AI 翻译。`,
        );
      const text = output.trim();
      outputLength += text.length;
      if (text.length > 100_000 || outputLength > MAX_TEXT)
        throw new TranslationError('Google 翻译结果过大，请拆分字幕后重试。');
      translations[cue.id] = text;
      onTranslation?.(cue.id, text);
      if (signal.aborted) throw cancelled();
      onProgress(
        index + 1,
        cues.length,
        sameLanguage ? '原字幕已是目标语言' : `Google 翻译 ${index + 1} / ${cues.length}`,
      );
    }
    if (signal.aborted) throw cancelled();
    return translations;
  } catch (error) {
    if (signal.aborted) throw cancelled();
    throw nativeError(error, stage);
  } finally {
    active = false;
    signal.removeEventListener('abort', release);
    release();
  }
}
