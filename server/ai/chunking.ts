import type { Cue } from '../../src/shared/types';

/**
 * Retrieval works on passages, not on cues. A cue is a line of subtitle — far too small to carry a
 * point on its own — so the transcript is regrouped into overlapping windows that each hold a
 * complete thought and remember where in the video they came from.
 */
export interface TranscriptChunk {
  index: number;
  start: number;
  end: number;
  text: string;
}

export interface ChunkOptions {
  targetTokens?: number;
  overlapTokens?: number;
  maxChunks?: number;
}

/** Roughly a paragraph: long enough to stand alone, short enough that a hit points somewhere. */
const TARGET_TOKENS = 350;
const OVERLAP_TOKENS = 60;
/** A five-hour video would otherwise cost thousands of embedding calls for diminishing return. */
const MAX_CHUNKS = 400;
/** Well under the per-input limit of every embedding model we target. */
const MAX_CHARS = 4_000;

const CJK = /[㐀-鿿豈-﫿぀-ヿ가-힯]/gu;

/**
 * Close enough to budget by, without shipping a tokenizer. CJK is about one token per character
 * while latin script is nearer four characters per token, and a chunker that ignores the
 * difference produces Chinese chunks four times too large.
 */
export function approxTokens(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

export function chunkCues(cues: Cue[], options: ChunkOptions = {}): TranscriptChunk[] {
  const target = Math.max(1, options.targetTokens ?? TARGET_TOKENS);
  // Overlap beyond half the window would make consecutive chunks near-duplicates.
  const overlap = Math.min(options.overlapTokens ?? OVERLAP_TOKENS, Math.floor(target / 2));
  const maxChunks = Math.max(1, options.maxChunks ?? MAX_CHUNKS);
  const usable = cues.filter((cue) => cue.text.trim());
  const chunks: TranscriptChunk[] = [];

  let first = 0;
  while (first < usable.length && chunks.length < maxChunks) {
    const parts: string[] = [];
    let tokens = 0;
    let last = first;
    // The `!parts.length` term guarantees one cue is always taken, even an oversized one.
    while (last < usable.length && (tokens < target || !parts.length)) {
      const text = usable[last]!.text.trim();
      parts.push(text);
      tokens += approxTokens(text);
      last += 1;
    }
    const start = usable[first]!.start;
    chunks.push({
      index: chunks.length,
      start,
      end: Math.max(usable[last - 1]!.end, start),
      text: parts.join(' ').slice(0, MAX_CHARS),
    });
    if (last >= usable.length) break;

    // Step back so a point made across a boundary survives whole in one of the two chunks.
    let back = last - 1;
    let carried = 0;
    while (back > first + 1 && carried < overlap) {
      carried += approxTokens(usable[back]!.text);
      back -= 1;
    }
    first = Math.max(first + 1, back);
  }
  return chunks;
}
