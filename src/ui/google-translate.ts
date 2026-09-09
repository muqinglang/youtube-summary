import type { PublicSettings } from '../shared/types';

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

class TranslationError extends Error {}

export function resolveTranslationEngine(
  settings: Pick<PublicSettings, 'hasApiKey' | 'model'> &
    Partial<Pick<PublicSettings, 'translationEngine'>>,
): 'google' | 'ai' {
  // Default to Google (instant, no key) like Trancy's "Default subtitles"; AI is opt-in.
  // The Google engine is the cloud endpoint in cloud-translate.ts, not an on-device model.
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
