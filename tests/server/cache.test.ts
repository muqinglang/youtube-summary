import { describe, expect, it } from 'vitest';
import { createHarness, longCues, register, runJob, transcriptFor, VIDEO } from './harness';

const CUES = longCues();

function request(task: 'outline' | 'guide' | 'summarize', overrides: Record<string, unknown> = {}) {
  return {
    task,
    video: VIDEO,
    transcript: transcriptFor(CUES),
    language: '简体中文',
    ...(task === 'summarize' ? { prompt: '请总结要点。' } : {}),
    ...overrides,
  };
}

describe('shared video cache', () => {
  it('charges the first viewer and serves everyone else from the cache', async () => {
    const { app, client } = createHarness();
    const first = await register(app, 'first@example.com');
    const second = await register(app, 'second@example.com');

    const a = await runJob(app, first, request('outline'));
    expect(a.cached).toBe(false);
    expect(a.result).toBeTruthy();
    // Four long cues become four batches, then one synthesis call.
    expect(client.calls).toEqual({ digest: 4, final: 1 });

    const b = await runJob(app, second, request('outline'));
    expect(b.cached).toBe(true);
    expect(b.result).toEqual(a.result);
    // The decisive assertion: a second account cost the provider nothing at all.
    expect(client.calls).toEqual({ digest: 4, final: 1 });
  });

  it('reuses fragment digests across the tasks that read identical evidence', async () => {
    const { app, client } = createHarness();
    const token = await register(app, 'reader@example.com');

    await runJob(app, token, request('outline'));
    expect(client.calls).toEqual({ digest: 4, final: 1 });

    // Guide sends no extra context, so its evidence is byte-identical to the outline's and every
    // digest is a cache hit; only the final synthesis is new.
    await runJob(app, token, request('guide'));
    expect(client.calls).toEqual({ digest: 4, final: 2 });

    // Summarize folds the user's prompt into the evidence, so its digests are genuinely different
    // work and are not pretended to be shareable.
    await runJob(app, token, request('summarize'));
    expect(client.calls).toEqual({ digest: 8, final: 3 });
  });

  it('misses when anything that changes the answer changes', async () => {
    // A generous allowance: a job blocked by the quota also reports `cached: false`, which would
    // let these assertions pass without the cache ever being consulted.
    const { app, client } = createHarness({ config: { dailyJobLimit: 50 } });
    const token = await register(app, 'reader@example.com');
    const fresh = async (body: unknown) => {
      const outcome = await runJob(app, token, body);
      expect(outcome.status).toBe(202);
      expect(outcome.cached).toBe(false);
      return outcome;
    };

    await fresh(request('outline'));
    const base = { ...client.calls };

    await fresh(request('outline', { language: '日本語' }));
    expect(client.calls.final).toBe(base.final + 1);

    // A re-read transcript with different text must not serve the previous video's outline.
    await fresh({ ...request('outline'), transcript: transcriptFor(longCues(4, 'edited-')) });

    await fresh(request('summarize'));
    await fresh(request('summarize', { prompt: '换一个要求。' }));
    const repeated = await runJob(app, token, request('summarize'));
    expect(repeated.cached).toBe(true);
  });

  it('records the video in the requester library without duplicating it', async () => {
    const { app } = createHarness();
    const token = await register(app, 'reader@example.com');
    await runJob(app, token, request('outline'));
    await runJob(app, token, request('guide'));
    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.json<{ library: string[] }>().library).toEqual([VIDEO.id]);
  });
});

describe('hosted quota', () => {
  it('counts only work that actually ran, and points at BYOK when exhausted', async () => {
    const { app, client } = createHarness({ config: { dailyJobLimit: 2 } });
    const token = await register(app, 'reader@example.com');

    await runJob(app, token, request('outline'));
    await runJob(app, token, request('guide'));
    const blocked = await runJob(app, token, request('summarize'));
    expect(blocked.status).toBe(402);
    expect(blocked.error).toContain('API Key');
    const spent = { ...client.calls };

    // A cached artifact is free, so it stays available after the daily allowance is gone.
    const cached = await runJob(app, token, request('outline'));
    expect(cached.cached).toBe(true);
    expect(client.calls).toEqual(spent);

    // Another account has its own allowance and is unaffected.
    const other = await register(app, 'other@example.com');
    const fresh = await runJob(app, other, request('summarize'));
    expect(fresh.status).toBe(202);
  });
});
