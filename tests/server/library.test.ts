import { describe, expect, it } from 'vitest';
import type { Embedder } from '../../server/ai/embeddings';
import { createLibraryService } from '../../server/ai/library';
import { createMemoryStore } from '../../server/store/memory';
import type { Store } from '../../server/store/types';
import type { Cue } from '../../src/shared/types';
import { lexicalEmbedder } from './harness';

function cuesFor(sentences: string[], offset = 0): Cue[] {
  return sentences.map((text, index) => ({
    id: `cue-${offset + index}`,
    start: (offset + index) * 30,
    end: (offset + index) * 30 + 29,
    text,
  }));
}

const PLANTS = cuesFor([
  'photosynthesis lets plants turn sunlight into chemical energy',
  'chlorophyll in the leaf absorbs the light that drives the reaction',
]);
const TRANSFORMERS = cuesFor(
  [
    'the transformer architecture replaced recurrent networks for sequence modelling',
    'attention lets every token look at every other token in the input',
  ],
  10,
);

function build(librarySearch = true) {
  const store: Store = createMemoryStore();
  if (!librarySearch) delete store.chunks;
  const embedder = lexicalEmbedder();
  const library = createLibraryService(store, embedder, (error) => {
    throw error;
  });
  return { store, embedder, library };
}

describe('cross-video library', () => {
  it('is unavailable, rather than broken, when the store has no vector support', () => {
    expect(build(false).library).toBeUndefined();
  });

  it('finds the video that discusses the query, not the one that merely exists', async () => {
    const { library } = build();
    library!.schedule('plants', PLANTS);
    library!.schedule('transformers', TRANSFORMERS);
    await library!.idle();

    const matches = await library!.search(['plants', 'transformers'], 'how plants use sunlight', 5);
    expect(matches[0]?.videoId).toBe('plants');
    expect(matches[0]?.text).toContain('sunlight');
    // Timestamps survive the round trip, which is what makes a hit clickable.
    expect(matches[0]?.start).toBe(0);
    expect(matches[0]!.score).toBeGreaterThan(0);

    const other = await library!.search(['plants', 'transformers'], 'attention between tokens', 5);
    expect(other[0]?.videoId).toBe('transformers');
  });

  it('searches only the videos it is given, so one account cannot read another library', async () => {
    const { library } = build();
    library!.schedule('plants', PLANTS);
    library!.schedule('transformers', TRANSFORMERS);
    await library!.idle();

    const matches = await library!.search(['transformers'], 'how plants use sunlight', 5);
    expect(matches.every((match) => match.videoId === 'transformers')).toBe(true);
    expect(await library!.search([], 'anything at all', 5)).toEqual([]);
  });

  it('skips a video it has already indexed and re-indexes one whose transcript changed', async () => {
    const { library, embedder } = build();
    library!.schedule('plants', PLANTS);
    await library!.idle();
    const afterFirst = embedder.calls.texts;
    expect(afterFirst).toBeGreaterThan(0);

    library!.schedule('plants', PLANTS);
    await library!.idle();
    // The expensive half of the feature; paying twice for the same transcript is the bug.
    expect(embedder.calls.texts).toBe(afterFirst);

    library!.schedule('plants', [...PLANTS, ...cuesFor(['a newly added closing remark'], 5)]);
    await library!.idle();
    expect(embedder.calls.texts).toBeGreaterThan(afterFirst);
  });

  it('indexes a video once when a second request arrives while the first is still running', async () => {
    // The stored-vector check cannot catch this one: the first request has not written anything
    // yet, so without the in-flight guard both requests pay the provider for the same video.
    const store: Store = createMemoryStore();
    const inner = lexicalEmbedder();
    let reachedProvider!: () => void;
    let release!: () => void;
    const arrived = new Promise<void>((resolve) => {
      reachedProvider = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: Embedder = {
      ...inner,
      embed: async (texts) => {
        reachedProvider();
        await gate;
        return inner.embed(texts);
      },
    };
    const library = createLibraryService(store, slow, (error) => {
      throw error;
    })!;

    library.schedule('plants', PLANTS);
    await arrived;
    library.schedule('plants', PLANTS);
    // The provider is still held, so nothing has been written yet. Give the second request more
    // than enough time to get past the stored-vector check; only the guard can stop it there.
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await library.idle();

    expect(inner.calls.batches).toBe(1);
  });

  it('spreads results across videos instead of returning one video eight times', async () => {
    const { library } = build();
    // Long enough that each cue becomes its own chunk, so one video can dominate.
    const many = (topic: string) =>
      cuesFor(
        Array.from(
          { length: 4 },
          (_, index) => `${topic} passage ${index} ${'padding '.repeat(200)}`,
        ),
      );
    library!.schedule('alpha', many('gradient descent'));
    library!.schedule('beta', many('gradient descent'));
    await library!.idle();

    const matches = await library!.search(['alpha', 'beta'], 'gradient descent', 6);
    const perVideo = new Map<string, number>();
    for (const match of matches)
      perVideo.set(match.videoId, (perVideo.get(match.videoId) ?? 0) + 1);
    expect([...perVideo.values()].every((count) => count <= 2)).toBe(true);
    expect(perVideo.size).toBe(2);
  });

  it('rejects an empty query rather than embedding whitespace', async () => {
    const { library, embedder } = build();
    await expect(library!.search(['plants'], '   ', 5)).rejects.toThrow('请输入');
    expect(embedder.calls.batches).toBe(0);
  });
});
