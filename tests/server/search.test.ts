import { describe, expect, it } from 'vitest';
import { createHarness, register, runJob, transcriptFor, VIDEO } from './harness';
import type { Cue } from '../../src/shared/types';

function cues(sentences: string[]): Cue[] {
  return sentences.map((text, index) => ({
    id: `cue-${index}`,
    start: index * 60,
    end: index * 60 + 59,
    text,
  }));
}

const PLANTS = cues([
  'photosynthesis lets plants turn sunlight into chemical energy',
  'chlorophyll in the leaf absorbs the light that drives the reaction',
]);
const FINANCE = cues([
  'compound interest is what makes an early retirement contribution grow',
  'the rate matters far less than the number of years you leave it alone',
]);

const PLANTS_VIDEO = { ...VIDEO, id: 'plants-1', title: 'Photosynthesis explained' };
const FINANCE_VIDEO = {
  ...VIDEO,
  id: 'finance-1',
  title: 'Compound interest explained',
  author: 'Money Weekly',
  url: 'https://www.youtube.com/watch?v=finance-1',
};

function outlineFor(video: typeof VIDEO, transcriptCues: Cue[]) {
  return {
    task: 'outline' as const,
    video,
    transcript: transcriptFor(transcriptCues, video.id),
    language: '简体中文',
  };
}

async function search(
  app: ReturnType<typeof createHarness>['app'],
  token: string,
  query: string,
  limit?: number,
) {
  return app.inject({
    method: 'POST',
    url: '/v1/library/search',
    headers: { authorization: `Bearer ${token}` },
    payload: { query, ...(limit === undefined ? {} : { limit }) },
  });
}

describe('cross-video search over a library', () => {
  it('refuses without a session and reports itself off when the server has no embeddings', async () => {
    const open = createHarness();
    expect((await search(open.app, 'not-a-token', 'anything')).statusCode).toBe(401);

    const disabled = createHarness({ librarySearch: false });
    const token = await register(disabled.app, 'reader@example.com');
    const response = await search(disabled.app, token, 'anything');
    // A deployment with no embedding key is a configuration, not a fault; the extension reads
    // this to hide the surface rather than offer a button that fails.
    expect(response.statusCode).toBe(501);
    const me = await disabled.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.json<{ features: { librarySearch: boolean } }>().features.librarySearch).toBe(false);
  });

  it('indexes what a job watched and later finds it by meaning, with the video attached', async () => {
    const { app, library } = createHarness({ config: { dailyJobLimit: 50 } });
    const token = await register(app, 'reader@example.com');
    await runJob(app, token, outlineFor(PLANTS_VIDEO, PLANTS));
    await runJob(app, token, outlineFor(FINANCE_VIDEO, FINANCE));
    await library!.idle();

    const response = await search(app, token, 'how does a plant use sunlight');
    expect(response.statusCode).toBe(200);
    const { matches } = response.json<{
      matches: { videoId: string; title: string; url: string; start: number; score: number }[];
    }>();
    expect(matches[0]?.videoId).toBe('plants-1');
    // Enough to render a result the user can click: which video, and where in it.
    expect(matches[0]?.title).toBe('Photosynthesis explained');
    expect(matches[0]?.start).toBe(0);
    expect(matches[0]!.score).toBeGreaterThan(0);

    const money = await search(app, token, 'why do early contributions matter');
    expect(money.json<{ matches: { videoId: string; url: string }[] }>().matches[0]).toMatchObject({
      videoId: 'finance-1',
      url: 'https://www.youtube.com/watch?v=finance-1',
    });
  });

  it('never reaches across accounts, even though the artifact cache is shared', async () => {
    const { app, library } = createHarness({ config: { dailyJobLimit: 50 } });
    const owner = await register(app, 'owner@example.com');
    const stranger = await register(app, 'stranger@example.com');
    await runJob(app, owner, outlineFor(PLANTS_VIDEO, PLANTS));
    await library!.idle();

    expect(
      (await search(app, owner, 'sunlight')).json<{ matches: unknown[] }>().matches,
    ).toHaveLength(1);
    // The stranger's account has watched nothing, so their library is empty — the vectors exist
    // and are shared, but only the videos this account watched are searchable.
    expect(
      (await search(app, stranger, 'sunlight')).json<{ matches: unknown[] }>().matches,
    ).toEqual([]);
  });

  it('rejects an empty query and a limit outside the allowed range', async () => {
    const { app } = createHarness();
    const token = await register(app, 'reader@example.com');
    expect((await search(app, token, '   ')).statusCode).toBe(400);
    expect((await search(app, token, 'ok', 0)).statusCode).toBe(400);
    expect((await search(app, token, 'ok', 999)).statusCode).toBe(400);
  });
});
