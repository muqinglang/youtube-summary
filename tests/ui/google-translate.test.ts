import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  googleTranslateUrl,
  resolveTranslationEngine,
  translateWithGoogle,
} from '../../src/ui/google-translate';
import type { Transcript } from '../../src/shared/types';

type CreateOptions = {
  sourceLanguage?: string;
  targetLanguage?: string;
  signal: AbortSignal;
  monitor: (target: {
    addEventListener: (name: string, callback: (event: { loaded: number }) => void) => void;
  }) => void;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function transcript(language = 'en-US'): Transcript {
  return {
    videoId: 'QLLuZbuTIRc',
    language,
    source: 'youtube',
    coverage: 'complete',
    cues: [
      { id: 'first', start: 0.25, end: 3.5, text: 'We learn by asking useful questions.' },
      { id: 'second', start: 7, end: 12, text: 'Then we test our answers with evidence.' },
    ],
  };
}

describe('translation engine choice and web fallback', () => {
  it.each([
    // Google is the default ("Default subtitles"); AI is opt-in only when explicitly chosen.
    [{ hasApiKey: false, model: '' }, 'google'],
    [{ hasApiKey: true, model: 'model' }, 'google'],
    [{ translationEngine: 'auto', hasApiKey: true, model: 'model' }, 'google'],
    [{ translationEngine: 'auto', hasApiKey: false, model: 'model' }, 'google'],
    [{ translationEngine: 'google', hasApiKey: true, model: 'model' }, 'google'],
    [{ translationEngine: 'ai', hasApiKey: true, model: 'model' }, 'ai'],
    [{ translationEngine: 'ai', hasApiKey: false, model: '' }, 'ai'],
  ] as const)('resolves %j to %s', (settings, expected) => {
    expect(resolveTranslationEngine(settings)).toBe(expected);
  });

  it('opens only Google Translate with an encoded, bounded current cue', () => {
    const url = new URL(
      googleTranslateUrl('hello & # <script>世界 ' + '字'.repeat(6_000), '简体中文'),
    );
    expect(url.origin + url.pathname).toBe('https://translate.google.com/');
    expect(url.searchParams.get('sl')).toBe('auto');
    expect(url.searchParams.get('tl')).toBe('zh');
    expect(url.searchParams.get('op')).toBe('translate');
    expect(url.searchParams.get('text')).toHaveLength(5_000);
    expect(url.searchParams.get('text')).toMatch(/^hello & # <script>世界/);
    expect(url.hash).toBe('');
    expect(() => googleTranslateUrl('', 'English')).toThrow('选择一条');
    expect(() => googleTranslateUrl('hello', 'https://evil.test')).toThrow('目标语言无效');
  });
});

describe('official Chrome translation sessions', () => {
  const translator = {
    translate: vi.fn<(text: string, options: { signal: AbortSignal }) => Promise<string>>(),
    destroy: vi.fn(),
  };
  const detector = {
    detect:
      vi.fn<
        (
          text: string,
          options: { signal: AbortSignal },
        ) => Promise<{ detectedLanguage: string; confidence: number }[]>
      >(),
    destroy: vi.fn(),
  };
  const Translator = {
    availability:
      vi.fn<(pair: { sourceLanguage: string; targetLanguage: string }) => Promise<string>>(),
    create: vi.fn<(options: CreateOptions) => Promise<typeof translator>>(),
  };
  const LanguageDetector = {
    availability: vi.fn<() => Promise<string>>(),
    create: vi.fn<(options: CreateOptions) => Promise<typeof detector>>(),
  };
  let controller: AbortController;
  let progress: ReturnType<typeof vi.fn<(completed: number, total: number, label: string) => void>>;
  let translated: ReturnType<typeof vi.fn<(id: string, text: string) => void>>;

  beforeEach(() => {
    vi.resetAllMocks();
    controller = new AbortController();
    progress = vi.fn();
    translated = vi.fn();
    Translator.availability.mockResolvedValue('available');
    Translator.create.mockResolvedValue(translator);
    translator.translate.mockImplementation(async (text) => `译文：${text}`);
    LanguageDetector.availability.mockResolvedValue('available');
    LanguageDetector.create.mockResolvedValue(detector);
    detector.detect.mockResolvedValue([{ detectedLanguage: 'en', confidence: 0.95 }]);
    vi.stubGlobal('window', { Translator, LanguageDetector });
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function translate(input = transcript(), target = '简体中文') {
    return translateWithGoogle(input, target, controller.signal, progress, translated);
  }

  it.each([
    ['简体中文', 'zh'],
    ['English', 'en'],
    ['日本語', 'ja'],
    ['한국어', 'ko'],
    ['Español', 'es'],
    ['Français', 'fr'],
    ['Deutsch', 'de'],
    ['Português', 'pt'],
    ['العربية', 'ar'],
    ['हिन्दी', 'hi'],
  ])('maps the UI target %s to %s', async (label, code) => {
    await translate(transcript('ru'), label);
    expect(Translator.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceLanguage: 'ru',
        targetLanguage: code,
        signal: expect.any(AbortSignal),
        monitor: expect.any(Function),
      }),
    );
    expect(LanguageDetector.create).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['en-US', 'en'],
    ['pt-BR', 'pt'],
    ['zh-CN', 'zh'],
    ['zh-Hans-CN', 'zh'],
    ['zh-TW', 'zh-Hant'],
    ['zh-Hant-HK', 'zh-Hant'],
    ['zh-HK', 'zh-Hant'],
  ])('normalizes source %s to %s', async (source, expected) => {
    await translate(transcript(source), '日本語');
    expect(Translator.availability).toHaveBeenCalledWith({
      sourceLanguage: expected,
      targetLanguage: 'ja',
    });
  });

  it('translates sequentially, publishes each valid cue, and preserves IDs and timing', async () => {
    const first = deferred<string>();
    translator.translate.mockReturnValueOnce(first.promise).mockResolvedValueOnce(' 第二条译文 ');
    const input = transcript();
    input.cues[0]!.id = '__proto__';
    const original = structuredClone(input);
    const job = translate(input);
    await vi.waitFor(() => expect(translator.translate).toHaveBeenCalledTimes(1));
    expect(translated).not.toHaveBeenCalled();
    first.resolve(' 第一条译文 ');
    const result = await job;
    expect(Object.keys(result)).toEqual(['__proto__', 'second']);
    expect(result.__proto__).toBe('第一条译文');
    expect(result.second).toBe('第二条译文');
    expect(translated.mock.calls).toEqual([
      ['__proto__', '第一条译文'],
      ['second', '第二条译文'],
    ]);
    expect(translator.translate.mock.calls.map(([text]) => text)).toEqual(
      original.cues.map((cue) => cue.text),
    );
    expect(
      translator.translate.mock.calls.every(([, options]) => options.signal instanceof AbortSignal),
    ).toBe(true);
    expect(progress).toHaveBeenLastCalledWith(2, 2, 'Google 翻译 2 / 2');
    expect(input).toEqual(original);
    expect(translator.destroy).toHaveBeenCalledTimes(1);
  });

  it('uses originals with an explicit label when source and target are the same', async () => {
    vi.stubGlobal('window', {});
    const input = transcript();
    const result = await translate(input, 'English');
    expect(result.first).toBe(input.cues[0]!.text);
    expect(Translator.create).not.toHaveBeenCalled();
    expect(progress).toHaveBeenLastCalledWith(2, 2, '原字幕已是目标语言');
  });

  it('detects an unknown source with a bounded sample and releases the detector before translation', async () => {
    const input = transcript('auto');
    input.cues[0]!.text = 'Words with useful context. '.repeat(200);
    detector.detect.mockResolvedValue([{ detectedLanguage: 'es-MX', confidence: 0.9 }]);
    await translate(input);
    expect(detector.detect.mock.calls[0]?.[0]).toHaveLength(4_000);
    expect(detector.detect.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
    expect(Translator.availability).toHaveBeenCalledWith({
      sourceLanguage: 'es',
      targetLanguage: 'zh',
    });
    expect(detector.destroy).toHaveBeenCalledTimes(1);
    expect(detector.destroy.mock.invocationCallOrder[0]).toBeLessThan(
      Translator.create.mock.invocationCallOrder[0]!,
    );
  });

  it.each(
    [
      [],
      [{ detectedLanguage: 'und', confidence: 0.99 }],
      [{ detectedLanguage: 'en', confidence: 0.69 }],
      [{ detectedLanguage: 'en', confidence: NaN }],
      [{ detectedLanguage: 'en', confidence: 1.1 }],
    ].map((results) => ({ results })),
  )('rejects unreliable detected language $results', async ({ results }) => {
    detector.detect.mockResolvedValue(results);
    await expect(translate(transcript('auto'))).rejects.toThrow('无法可靠识别');
    expect(Translator.create).not.toHaveBeenCalled();
    expect(detector.destroy).toHaveBeenCalledTimes(1);
    expect(translated).not.toHaveBeenCalled();
  });

  it('reports download progress without marking any cue translated', async () => {
    Translator.availability.mockResolvedValue('downloadable');
    const ready = deferred<typeof translator>();
    let notify!: (event: { loaded: number }) => void;
    Translator.create.mockImplementation((options) => {
      options.monitor({
        addEventListener: (type, callback) => {
          expect(type).toBe('downloadprogress');
          notify = callback;
        },
      });
      return ready.promise;
    });
    const job = translate();
    await vi.waitFor(() => expect(Translator.create).toHaveBeenCalledTimes(1));
    notify({ loaded: 0.3458 });
    expect(progress).toHaveBeenLastCalledWith(0, 2, '首次使用，正在下载 Google 翻译语言包 35%');
    expect(translated).not.toHaveBeenCalled();
    ready.resolve(translator);
    await job;
    const calls = progress.mock.calls.length;
    notify({ loaded: 1 });
    expect(progress).toHaveBeenCalledTimes(calls);
  });

  it.each(['', '   ', null])(
    'rejects invalid output %j without completing progress',
    async (output) => {
      translator.translate.mockResolvedValueOnce(output as unknown as string);
      await expect(translate()).rejects.toThrow('第 1 条字幕的有效译文');
      expect(translated).not.toHaveBeenCalled();
      expect(progress.mock.calls.every(([completed]) => completed === 0)).toBe(true);
      expect(translator.destroy).toHaveBeenCalledTimes(1);
    },
  );

  it('retains only previously confirmed incremental results when a later cue fails', async () => {
    translator.translate.mockResolvedValueOnce('有效译文').mockResolvedValueOnce('');
    await expect(translate()).rejects.toThrow('第 2 条');
    expect(translated.mock.calls).toEqual([['first', '有效译文']]);
    expect(progress).toHaveBeenLastCalledWith(1, 2, 'Google 翻译 1 / 2');
  });

  it('gives an actionable unsupported-browser and unsupported-source error', async () => {
    vi.stubGlobal('window', {});
    await expect(translate()).rejects.toThrow('Chrome 138');
    vi.stubGlobal('window', { Translator });
    await expect(translate(transcript('auto'))).rejects.toThrow('无法自动识别');
    expect(Translator.create).not.toHaveBeenCalled();
  });

  it('does not create unsupported language pairs or detection models', async () => {
    Translator.availability.mockResolvedValue('unavailable');
    await expect(translate()).rejects.toThrow('en → zh目前不可用');
    expect(Translator.create).not.toHaveBeenCalled();
    LanguageDetector.availability.mockResolvedValue('unavailable');
    await expect(translate(transcript('auto'))).rejects.toThrow('语言识别模型目前不可用');
    expect(LanguageDetector.create).not.toHaveBeenCalled();
  });

  it.each([
    ['NetworkError', '下载失败'],
    ['NotAllowedError', '再次点击'],
    ['NotSupportedError', '不支持 Google'],
    ['QuotaExceededError', '模型容量'],
  ])('turns native %s into an actionable Chinese error', async (name, text) => {
    Translator.create.mockRejectedValue(new DOMException('Native error', name));
    await expect(translate()).rejects.toThrow(text);
    expect(translated).not.toHaveBeenCalled();
  });

  it('explains a renewed click when detector downloading outlives user activation', async () => {
    LanguageDetector.availability.mockResolvedValue('downloadable');
    Translator.create.mockRejectedValue(new DOMException('Requires activation', 'NotAllowedError'));
    await expect(translate(transcript('auto'))).rejects.toThrow('首次下载语言检测模型后');
    expect(detector.destroy).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized, duplicate, or empty input before using a native session', async () => {
    const input = transcript();
    input.cues[0]!.text = 'x'.repeat(10_001);
    await expect(translate(input)).rejects.toThrow('文本过大');
    input.cues[0]!.text = '  ';
    await expect(translate(input)).rejects.toThrow('空文本');
    input.cues[0]!.text = 'x';
    input.cues[1]!.id = 'first';
    await expect(translate(input)).rejects.toThrow('重复编号');
    expect(Translator.availability).not.toHaveBeenCalled();
  });

  it('does no work when already cancelled', async () => {
    controller.abort();
    await expect(translate()).rejects.toMatchObject({ name: 'AbortError' });
    expect(Translator.availability).not.toHaveBeenCalled();
  });

  it('aborts native creation and destroys a session that resolves after cancellation', async () => {
    const ready = deferred<typeof translator>();
    Translator.create.mockReturnValue(ready.promise);
    const job = translate();
    const rejected = expect(job).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(Translator.create).toHaveBeenCalledTimes(1));
    controller.abort();
    await rejected;
    expect(Translator.create.mock.calls[0]?.[0].signal.aborted).toBe(true);
    ready.resolve(translator);
    await Promise.resolve();
    expect(translator.destroy).toHaveBeenCalledTimes(1);
    expect(translator.translate).not.toHaveBeenCalled();
  });

  it('destroys an active translator immediately on cancel and ignores late translations', async () => {
    const output = deferred<string>();
    translator.translate.mockReturnValue(output.promise);
    const job = translate();
    const rejected = expect(job).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(translator.translate).toHaveBeenCalledTimes(1));
    controller.abort();
    expect(translator.destroy).toHaveBeenCalledTimes(1);
    expect(translator.translate.mock.calls[0]?.[1].signal.aborted).toBe(true);
    await rejected;
    output.resolve('迟到的译文');
    await Promise.resolve();
    expect(translated).not.toHaveBeenCalled();
    expect(translator.destroy).toHaveBeenCalledTimes(1);
  });

  it('destroys a language detector on cancellation', async () => {
    detector.detect.mockReturnValue(new Promise(() => {}));
    const job = translate(transcript('auto'));
    const rejected = expect(job).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(detector.detect).toHaveBeenCalledTimes(1));
    controller.abort();
    await rejected;
    expect(detector.destroy).toHaveBeenCalledTimes(1);
    expect(Translator.create).not.toHaveBeenCalled();
  });

  it('does not publish success if a cue callback cancels the job', async () => {
    translated.mockImplementation(() => controller.abort());
    await expect(translate()).rejects.toMatchObject({ name: 'AbortError' });
    expect(progress.mock.calls.every(([completed]) => completed === 0)).toBe(true);
    expect(translator.translate).toHaveBeenCalledTimes(1);
    expect(translator.destroy).toHaveBeenCalledTimes(1);
  });

  it('allows a 180-second model download, then aborts and cleans a late session', async () => {
    vi.useFakeTimers();
    const ready = deferred<typeof translator>();
    Translator.create.mockReturnValue(ready.promise);
    const job = translate();
    const rejected = expect(job).rejects.toThrow('语言包加载超时');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(179_999);
    expect(Translator.create.mock.calls[0]?.[0].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(Translator.create.mock.calls[0]?.[0].signal.aborted).toBe(true);
    ready.resolve(translator);
    await Promise.resolve();
    expect(translator.destroy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('limits each cue to 25 seconds and releases the translator', async () => {
    vi.useFakeTimers();
    translator.translate.mockReturnValue(new Promise(() => {}));
    const job = translate();
    const rejected = expect(job).rejects.toThrow('字幕翻译超时');
    await vi.advanceTimersByTimeAsync(25_000);
    await rejected;
    expect(translator.translate.mock.calls[0]?.[1].signal.aborted).toBe(true);
    expect(translator.destroy).toHaveBeenCalledTimes(1);
    expect(translated).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
