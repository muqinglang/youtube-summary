import { describe, expect, it } from 'vitest';
import { watchUrl } from '../../src/shared/youtube';

describe('watch links built from a video id', () => {
  it('builds an https watch link at the requested second', () => {
    expect(watchUrl('QLLuZbuTIRc', 259.7)).toBe(
      'https://www.youtube.com/watch?v=QLLuZbuTIRc&t=259s',
    );
    expect(watchUrl('QLLuZbuTIRc')).toBe('https://www.youtube.com/watch?v=QLLuZbuTIRc&t=0s');
    // A negative or nonsense offset lands at the start rather than producing a broken link.
    expect(watchUrl('QLLuZbuTIRc', -30)).toContain('&t=0s');
    expect(watchUrl('QLLuZbuTIRc', Number.NaN)).toContain('&t=0s');
  });

  it.each([
    'javascript:alert(1)',
    'https://evil.test/steal',
    '../../etc/passwd',
    'QLLuZbuTIRc&t=1"><script>',
    'QLLuZbuTIRc?x=1',
    'short',
    '',
    'a'.repeat(64),
  ])('refuses %j rather than turning it into a link', (candidate) => {
    // Cross-video results come from whichever account uploaded that video's metadata, so the
    // only safe input is an id that matches; everything else must produce no link at all.
    expect(watchUrl(candidate, 10)).toBeUndefined();
  });

  it('produces a URL whose origin and video are exactly what was asked for', () => {
    const url = new URL(watchUrl('dQw4w9WgXcQ', 5)!);
    expect(url.origin).toBe('https://www.youtube.com');
    expect(url.pathname).toBe('/watch');
    expect(url.searchParams.get('v')).toBe('dQw4w9WgXcQ');
  });
});
