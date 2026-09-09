import { describe, expect, it } from 'vitest';
import { googleTranslateUrl, resolveTranslationEngine } from '../../src/ui/google-translate';

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
