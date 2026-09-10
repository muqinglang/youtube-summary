import { describe, expect, it } from 'vitest';
import { approxTokens, chunkCues } from '../../server/ai/chunking';
import type { Cue } from '../../src/shared/types';

function cues(texts: string[]): Cue[] {
  return texts.map((text, index) => ({
    id: `cue-${index}`,
    start: index * 10,
    end: index * 10 + 9,
    text,
  }));
}

describe('transcript chunking', () => {
  it('counts CJK far heavier than latin script', () => {
    // The whole reason for a weighted count: the same character count is a very different
    // amount of meaning, and a chunker that ignores it makes Chinese chunks four times too big.
    expect(approxTokens('a'.repeat(100))).toBe(25);
    expect(approxTokens('中'.repeat(100))).toBe(100);
    expect(approxTokens('日本語のテキスト')).toBe(8);
    expect(approxTokens('')).toBe(0);
  });

  it('groups cues into windows near the target size, in order', () => {
    const chunks = chunkCues(cues(Array.from({ length: 40 }, () => 'word '.repeat(20))), {
      targetTokens: 100,
      overlapTokens: 0,
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(approxTokens(chunk.text)).toBeGreaterThanOrEqual(100);
    // Ordered, indexed from zero, and each chunk knows where in the video it came from.
    expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, index) => index));
    for (let index = 1; index < chunks.length; index += 1)
      expect(chunks[index]!.start).toBeGreaterThan(chunks[index - 1]!.start);
    expect(chunks[0]!.start).toBe(0);
    expect(chunks.at(-1)!.end).toBe(399);
  });

  it('overlaps neighbours so a point made across a boundary survives whole', () => {
    const chunks = chunkCues(
      cues(Array.from({ length: 12 }, (_, index) => `sentence number ${index} ${'pad '.repeat(20)}`)),
      { targetTokens: 60, overlapTokens: 30 },
    );
    expect(chunks.length).toBeGreaterThan(1);
    const first = new Set(chunks[0]!.text.match(/number \d+/g));
    const second = new Set(chunks[1]!.text.match(/number \d+/g));
    expect([...second].some((phrase) => first.has(phrase))).toBe(true);
    // Overlap is capped at half the window, otherwise neighbours become near-duplicates.
    expect([...second].every((phrase) => first.has(phrase))).toBe(false);
  });

  it('always advances, even when one cue alone busts the whole budget', () => {
    const chunks = chunkCues(
      [
        { id: 'giant', start: 0, end: 5, text: 'x'.repeat(50_000) },
        { id: 'tail', start: 5, end: 9, text: 'the tail cue must still be reachable' },
      ],
      { targetTokens: 50 },
    );
    expect(chunks).toHaveLength(2);
    // Truncated to the per-input cap rather than sent to a provider that would reject it.
    expect(chunks[0]!.text.length).toBe(4_000);
    expect(chunks[1]!.text).toContain('tail cue');
  });

  it('stops at the chunk cap instead of indexing a five-hour video without limit', () => {
    const chunks = chunkCues(cues(Array.from({ length: 500 }, () => 'word '.repeat(200))), {
      maxChunks: 7,
    });
    expect(chunks).toHaveLength(7);
  });

  it('ignores blank cues and returns nothing for an empty transcript', () => {
    expect(chunkCues([])).toEqual([]);
    expect(chunkCues(cues(['  ', '', '\n']))).toEqual([]);
    const chunks = chunkCues(cues(['   ', 'the only real line', '  ']));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe('the only real line');
    // The timestamps come from the cue that carried the text, not from the blanks around it.
    expect(chunks[0]!.start).toBe(10);
  });
});
