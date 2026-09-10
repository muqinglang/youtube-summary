import { describe, expect, it } from 'vitest';
import { errorMessage } from '../../src/ui/dom';

/** Stands in for the parent realm: a constructor whose prototype chain is not this realm's. */
function foreignError(message: string): unknown {
  const Foreign = function (this: { message: string; name: string }, text: string) {
    this.message = text;
    this.name = 'Error';
  } as unknown as new (text: string) => object;
  Foreign.prototype = Object.create(null);
  return new Foreign(message);
}

describe('surfacing a failure reason', () => {
  it('reads the message from an error built in another realm', () => {
    // The learning page constructs errors in the parent window; `instanceof Error` is false for
    // those inside the panel iframe, which silently discarded every real cause.
    const cause = foreignError('原标签页已切换到其他视频，请返回当前视频后重新读取。');
    expect(cause instanceof Error).toBe(false);
    expect(errorMessage(cause)).toBe('原标签页已切换到其他视频，请返回当前视频后重新读取。');
  });

  it('still reads a same-realm Error and a DOMException', () => {
    expect(errorMessage(new Error('字幕轨为空'))).toBe('字幕轨为空');
    expect(errorMessage(new DOMException('已取消', 'AbortError'))).toBe('已取消');
  });

  it('falls back only when there is genuinely nothing to say', () => {
    for (const value of [undefined, null, 'a bare string', 42, {}, { message: '' }, new Error('')])
      expect(errorMessage(value)).toBe('操作失败，请重试。');
  });
});
