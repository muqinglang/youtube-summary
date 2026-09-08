import type { Cue } from '../shared/types';

/** Trancy-style cloud translation: Google's public web endpoint. No on-device model download. */
const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const POOL = 6;

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

async function translateOne(text: string, tl: string, signal: AbortSignal): Promise<string> {
  const url =
    `${ENDPOINT}?client=gtx&sl=auto&dt=t&tl=${encodeURIComponent(tl)}` +
    `&q=${encodeURIComponent(text.slice(0, 4000))}`;
  const response = await fetch(url, { signal, credentials: 'omit', cache: 'no-store' });
  if (!response.ok)
    throw new Error(
      response.status === 429
        ? 'Google 翻译请求过于频繁，请稍后再试，或切换「AI 字幕」。'
        : `Google 翻译失败（HTTP ${response.status}），请重试或切换「AI 字幕」。`,
    );
  const data: unknown = await response.json();
  const segments = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : [];
  const output = segments
    .map((segment) => (Array.isArray(segment) ? String(segment[0] ?? '') : ''))
    .join('');
  if (!output.trim()) throw new Error('Google 翻译返回了空结果，请重试。');
  return output.trim();
}

/** Translate an arbitrary set of cues concurrently; preserves each cue id. */
export async function translateCuesCloud(
  cues: Cue[],
  language: string,
  signal: AbortSignal,
): Promise<Record<string, string>> {
  const tl = targetCode(language);
  const map: Record<string, string> = Object.create(null) as Record<string, string>;
  let next = 0;
  async function worker(): Promise<void> {
    while (next < cues.length) {
      if (signal.aborted) throw new DOMException('已取消', 'AbortError');
      const cue = cues[next++];
      if (!cue) continue;
      map[cue.id] = await translateOne(cue.text, tl, signal);
    }
  }
  await Promise.all(Array.from({ length: Math.min(POOL, cues.length) }, () => worker()));
  return map;
}
