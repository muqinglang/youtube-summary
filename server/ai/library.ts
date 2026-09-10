import type { Cue } from '../../src/shared/types';
import type { ChunkMatch, Store } from '../store/types';
import { chunkCues } from './chunking';
import type { Embedder } from './embeddings';
import { cuesFingerprint } from './gateway';

/** Bump when the chunking rules change, so existing videos re-index instead of mixing schemes. */
const INDEX_VERSION = 1;
const MAX_QUERY_CHARS = 500;
export const MAX_SEARCH_RESULTS = 20;
/** One video should not fill the whole result list; the point of the feature is the other videos. */
const PER_VIDEO_LIMIT = 2;

export interface LibrarySearchOptions {
  perVideoLimit?: number;
}

export interface LibraryService {
  /**
   * Indexes in the background. Callers are on a request path and the user is waiting on something
   * else; a missing index degrades the next search, it does not fail this request.
   */
  schedule(videoId: string, cues: Cue[]): void;
  search(videoIds: string[], query: string, limit: number): Promise<ChunkMatch[]>;
  /** Resolves once nothing is indexing. Exists so tests and shutdown can wait. */
  idle(): Promise<void>;
}

export class LibraryError extends Error {}

/**
 * Vectors are only worth storing when they were all produced the same way. This fingerprints the
 * transcript together with the model and its dimensions, so re-running after any of them changes
 * replaces the video's rows rather than comparing vectors from two different spaces.
 */
export async function chunkSource(cues: Cue[], embedder: Embedder): Promise<string> {
  return `${INDEX_VERSION}:${embedder.model}:${embedder.dimensions}:${await cuesFingerprint(cues)}`;
}

/** Undefined when the deployment has no vector store, which is the feature's off switch. */
export function createLibraryService(
  store: Store,
  embedder: Embedder,
  onError: (error: unknown) => void = (error) => console.warn('索引失败：', error),
): LibraryService | undefined {
  const chunks = store.chunks;
  if (!chunks) return undefined;
  const running = new Map<string, Promise<void>>();

  async function index(videoId: string, cues: Cue[]): Promise<void> {
    const source = await chunkSource(cues, embedder);
    if (await chunks!.has(videoId, source)) return;
    const passages = chunkCues(cues);
    if (!passages.length) return;
    const vectors = await embedder.embed(passages.map((passage) => passage.text));
    await chunks!.put(
      videoId,
      source,
      passages.map((passage, position) => ({ ...passage, embedding: vectors[position]! })),
    );
  }

  return {
    schedule(videoId, cues) {
      // Two jobs on the same video arrive together often — the same person opening two tabs, or
      // two people watching the same thing — and indexing it twice would pay the provider twice.
      if (running.has(videoId)) return;
      const task = index(videoId, cues)
        .catch(onError)
        .finally(() => running.delete(videoId));
      running.set(videoId, task);
    },
    async search(videoIds, query, limit) {
      const text = query.trim().slice(0, MAX_QUERY_CHARS);
      if (!text) throw new LibraryError('请输入要搜索的内容。');
      if (!videoIds.length) return [];
      const wanted = Math.min(Math.max(1, Math.trunc(limit)), MAX_SEARCH_RESULTS);
      const [embedding] = await embedder.embed([text]);
      // Over-fetch, because capping per video afterwards would otherwise return fewer than asked.
      const found = await chunks!.search(videoIds, embedding!, wanted * (PER_VIDEO_LIMIT + 3));
      const perVideo = new Map<string, number>();
      const matches: ChunkMatch[] = [];
      for (const match of found) {
        // No score threshold: what counts as "related" is calibrated per embedding model, and
        // this one has not been measured against real data. Scores are returned instead.
        if (match.score <= 0) continue;
        const used = perVideo.get(match.videoId) ?? 0;
        if (used >= PER_VIDEO_LIMIT) continue;
        perVideo.set(match.videoId, used + 1);
        matches.push(match);
        if (matches.length >= wanted) break;
      }
      return matches;
    },
    async idle() {
      await Promise.all([...running.values()]);
    },
  };
}
