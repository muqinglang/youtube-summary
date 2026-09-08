import { describe, expect, it } from 'vitest';
import { nativeSegmentsToJson3, nativeTimestamp } from '../../src/content/native-transcript';
import { parseTranscript } from '../../src/core/transcript';

describe('native YouTube transcript timestamps', () => {
  it.each([
    ['0:00', 0],
    ['5:02:13', 18133],
    ['90:05', 5405],
    ['1:02.250', 62.25],
    ['\u200e１:０２:０３\u200f', 3723],
    ['01:02,500', 62.5],
  ])('parses %s without mistaking accessible prose for a timestamp', (input, expected) => {
    expect(nativeTimestamp(input)).toBe(expected);
  });

  it.each([
    '',
    '5 hours, 2 minutes',
    '1:60',
    '1:70:02',
    '-1:03',
    '1:2',
    '999:00:00',
    '0:00<script>',
  ])('rejects malformed timestamp %s', (input) => {
    expect(nativeTimestamp(input)).toBeNull();
  });
});

describe('native panel to readable caption resource', () => {
  it('preserves Unicode and five-hour timestamps through the production parser', () => {
    const raw = nativeSegmentsToJson3(
      [
        { timestamp: '0:00', text: 'Start here. 从这里开始。' },
        { timestamp: '5:02:13', text: 'Keep on thinking.\n继续思考。' },
      ],
      18139,
    );
    expect(parseTranscript(raw)).toMatchObject([
      { start: 0, text: 'Start here. 从这里开始。' },
      { start: 18133, end: 18139, text: 'Keep on thinking. 继续思考。' },
    ]);
  });

  it('deduplicates identical DOM rows while preserving distinct phrases at one timestamp', () => {
    const raw = nativeSegmentsToJson3([
      { timestamp: '0:10', text: 'Second phrase' },
      { timestamp: '0:00', text: 'First phrase' },
      { timestamp: '0:00', text: 'First phrase' },
      { timestamp: '0:00', text: 'Different phrase' },
    ]);
    const events = JSON.parse(raw).events as { tStartMs: number; segs: { utf8: string }[] }[];
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.tStartMs)).toEqual([0, 0, 10000]);
    expect(events[1]?.segs[0]?.utf8).toBe('Different phrase');
  });

  it('keeps caption HTML as JSON text and rejects empty or oversized source rows', () => {
    const raw = nativeSegmentsToJson3([
      { timestamp: '0:00', text: '<img src=x onerror=alert(1)> "quote"' },
    ]);
    expect(JSON.parse(raw).events[0].segs[0].utf8).toBe('<img src=x onerror=alert(1)> "quote"');
    expect(() => nativeSegmentsToJson3([])).toThrow('没有可读取');
    expect(() => nativeSegmentsToJson3([{ timestamp: '0:00', text: ' ' }])).toThrow('格式暂不支持');
    expect(() => nativeSegmentsToJson3([{ timestamp: 'bad', text: 'Source' }])).toThrow(
      '格式暂不支持',
    );
    expect(() => nativeSegmentsToJson3([{ timestamp: '0:00', text: 'x'.repeat(10001) }])).toThrow(
      '内容过大',
    );
  });
});
