import { describe, expect, it } from 'vitest';
import {
  chunkCues,
  findCueIndex,
  formatTime,
  normalizeCues,
  parseTranscript,
} from '../../src/core/transcript';
import type { Cue } from '../../src/shared/types';

const cue = (start: number, end: number, text = 'hello', id = `cue-${start}`): Cue => ({
  id,
  start,
  end,
  text,
});

describe('parseTranscript', () => {
  it('reads multilingual SRT, line breaks, markup and hour timestamps', () => {
    const result = parseTranscript(
      '\uFEFF1\r\n01:02:03,400 --> 01:02:06,000\r\n<b>你好</b> &amp; 日本語\r\nمرحبا\r\n\r\n2\r\n01:02:07,000 --> 01:02:09,200\r\n끝',
    );
    expect(result).toEqual([
      cue(3723.4, 3726, '你好 & 日本語\nمرحبا', 'cue-0'),
      cue(3727, 3729.2, '끝', 'cue-1'),
    ]);
  });

  it('reads WebVTT identifiers/settings and ignores metadata, CSS and notes', () => {
    const input =
      'WEBVTT\nKind: captions\nLanguage: en\n\nNOTE a note\nignore this\n\nSTYLE\n::cue { color: lime; }\n\nREGION\nid:fred\n\nopening\n00:01.200 --> 00:03.500 align:start position:0%\n<v Roger><c.yellow>Hello</c> <00:02.000>world</v>\n\n00:05.000 --> 00:06.000\n2 &lt; 3';
    expect(parseTranscript(input)).toEqual([
      cue(1.2, 3.5, 'Hello world', 'cue-0'),
      cue(5, 6, '2 < 3', 'cue-1'),
    ]);
  });

  it('uses JSON3 segment offsets while joining words without inventing spaces', () => {
    const input = JSON.stringify({
      events: [
        { tStartMs: 0, id: 1, wpWinPosId: 0 },
        {
          tStartMs: 1000,
          dDurationMs: 3000,
          segs: [
            { utf8: '\n' },
            { utf8: '你', tOffsetMs: 200 },
            { utf8: '好 world', tOffsetMs: 700 },
          ],
        },
        { tStartMs: 5000, segs: [{ utf8: 'last', tOffsetMs: 500 }] },
      ],
    });
    expect(parseTranscript(input)).toEqual([
      cue(1.2, 4, '你好 world', 'cue-1'),
      cue(5.5, 8.5, 'last', 'cue-2'),
    ]);
  });

  it('infers missing JSON3 duration from next event, retaining the final cue', () => {
    const input = JSON.stringify({
      events: [
        { tStartMs: 0, segs: [{ utf8: 'first' }] },
        { tStartMs: 1500, segs: [{ utf8: 'second' }] },
      ],
    });
    expect(parseTranscript(input)).toEqual([
      cue(0, 1.5, 'first', 'cue-0'),
      cue(1.5, 4.5, 'second', 'cue-1'),
    ]);
  });

  it('reads classic XML with entities and mixed Unicode', () => {
    expect(
      parseTranscript(
        '<?xml version="1.0" encoding="utf-8"?><transcript><text start="0.25" dur="2.5">A &amp; B &#39; &#x1F600; &lt;3</text><text start="4" dur="1">你好<br/>日本語</text></transcript>',
      ),
    ).toEqual([cue(0.25, 2.75, "A & B ' 😀 <3", 'cue-0'), cue(4, 5, '你好\n日本語', 'cue-1')]);
  });

  it('reads srv3 ordered segments, milliseconds and first-segment offset', () => {
    const input =
      '<timedtext format="3"><head><wp id="1"/></head><body><p t="1000" d="2500"><s t="200">Hello </s><s t="800">世界</s>!</p><p t="4000" d="1000">Plain paragraph</p></body></timedtext>';
    expect(parseTranscript(input)).toEqual([
      cue(1.2, 3.5, 'Hello 世界!', 'cue-0'),
      cue(4, 5, 'Plain paragraph', 'cue-1'),
    ]);
  });

  it.each([
    '',
    'plain prose',
    'WEBVTT',
    '{broken',
    '{"events":[]}',
    '<html><body>not captions</body></html>',
    '<transcript><text start="0" dur="2">broken</transcript>',
    '<!DOCTYPE a [<!ENTITY x "hello">]><transcript><text start="0" dur="2">&x;</text></transcript>',
    '1\n00:70:00,000 --> 00:70:02,000\nwrong time',
    '1\n00:00:02,000 --> 00:00:01,000\nreverse',
    '1\n00:00:00,000 --> 00:00:00,000\nzero duration',
    '{"events":[{"tStartMs":-5,"dDurationMs":1000,"segs":[{"utf8":"x"}]}]}',
    '{"events":[{"tStartMs":0,"dDurationMs":1000,"segs":[{"utf8":"x","tOffsetMs":3000}]}]}',
  ])('rejects empty or malformed input with a useful error: %s', (input) => {
    expect(() => parseTranscript(input)).toThrow(/字幕|XML|JSON/);
  });

  it('rejects resource-limit violations instead of truncating text', () => {
    expect(() => parseTranscript('a'.repeat(10 * 1024 * 1024 + 1))).toThrow('10 MB');
    expect(() =>
      parseTranscript('1\n00:00:00,000 --> 00:00:01,000\n' + '字'.repeat(100_001)),
    ).toThrow('100,000');
    expect(() => normalizeCues([cue(0, Infinity)])).toThrow();
    expect(() => normalizeCues([cue(0, 604_801)])).toThrow('7 天');
  });
});

describe('normalization', () => {
  it('sorts without mutating input and makes IDs unique', () => {
    const input = [cue(5, 6, 'later', 'same'), cue(0, 2, 'early', 'same')];
    const original = structuredClone(input);
    expect(normalizeCues(input)).toEqual([
      cue(0, 2, 'early', 'same'),
      cue(5, 6, 'later', 'same-1'),
    ]);
    expect(input).toEqual(original);
  });

  it('merges overlapping duplicates but preserves deliberate later repetition', () => {
    expect(normalizeCues([cue(0, 2, 'No.'), cue(1, 3, 'No.'), cue(3, 4, 'No.')])).toEqual([
      cue(0, 3, 'No.'),
      cue(3, 4, 'No.'),
    ]);
  });

  it('removes repeated whole rolling lines, without deleting partial words or separate utterances', () => {
    expect(
      normalizeCues([
        cue(0, 3, 'first line'),
        cue(2, 5, 'first line\nsecond line'),
        cue(4, 7, 'second line\nthird line'),
        cue(7, 9, 'third line\nfourth line'),
      ]).map((item) => item.text),
    ).toEqual(['first line', 'second line', 'third line', 'third line\nfourth line']);
    expect(
      normalizeCues([cue(0, 3, 'I think'), cue(2, 5, 'I think therefore I am')]).map(
        (item) => item.text,
      ),
    ).toEqual(['I think', 'I think therefore I am']);
  });
});

describe('playback synchronization', () => {
  const cues = [cue(1, 2), cue(3, 5), cue(4, 4.5), cue(6, 7)];
  it.each([
    [0, -1],
    [1, 0],
    [2, -1],
    [3, 1],
    [4, 2],
    [4.5, 1],
    [5, -1],
    [7, -1],
    [NaN, -1],
    [Infinity, -1],
    [-1, -1],
  ])('locates active cue at %s seconds', (time, expected) => {
    expect(findCueIndex(cues, time)).toBe(expected);
  });
  it('handles empty input', () => expect(findCueIndex([], 100)).toBe(-1));
  it.each([
    [0, '0:00'],
    [59.99, '0:59'],
    [60, '1:00'],
    [3723.5, '1:02:03'],
    [18020, '5:00:20'],
    [-10, '0:00'],
    [NaN, '0:00'],
  ])('formats %s', (seconds, expected) => {
    expect(formatTime(seconds)).toBe(expected);
  });
});

describe('chunkCues', () => {
  it('preserves every cue once including oversized and final cues', () => {
    const input = ['aa', 'bbb', 'x'.repeat(25), 'four', 'last'].map((text, index) =>
      cue(index, index + 1, text),
    );
    const chunks = chunkCues(input, 10);
    expect(chunks.map((chunk) => chunk.map((item) => item.text))).toEqual([
      ['aa', 'bbb'],
      ['x'.repeat(25)],
      ['four', 'last'],
    ]);
    expect(chunks.flat()).toEqual(input);
    expect(chunks.flat().every((item, index) => item === input[index])).toBe(true);
  });
  it('returns no phantom chunk for empty input', () => expect(chunkCues([])).toEqual([]));
  it.each([0, -10, NaN, Infinity])('rejects invalid limit %s', (limit) =>
    expect(() => chunkCues([], limit)).toThrow(),
  );
});
