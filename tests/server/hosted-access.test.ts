import { describe, expect, it } from 'vitest';
import { createHarness, longCues, register, runJob, transcriptFor, VIDEO } from './harness';

const outline = {
  task: 'outline',
  video: VIDEO,
  transcript: transcriptFor(longCues()),
  language: '简体中文',
};

function harness(emails: string[]) {
  return createHarness({ config: { dailyJobLimit: 5, hostedEmails: new Set(emails) } });
}

async function limitOf(app: ReturnType<typeof createHarness>['app'], token: string) {
  const me = await app.inject({
    method: 'GET',
    url: '/v1/me',
    headers: { authorization: `Bearer ${token}` },
  });
  return me.json<{ usage: { dailyJobLimit: number } }>().usage.dailyJobLimit;
}

describe('hosted quota is for invited accounts only', () => {
  it('lets an invited account spend and turns everyone else toward their own key', async () => {
    const { app, client } = harness(['owner@example.com']);
    const owner = await register(app, 'owner@example.com');
    const stranger = await register(app, 'stranger@example.com');

    expect(await limitOf(app, owner)).toBe(5);
    // The extension reads this, so a stranger is told up front rather than on first use.
    expect(await limitOf(app, stranger)).toBe(0);

    const denied = await runJob(app, stranger, { ...outline, language: 'English' });
    expect(denied.status).toBe(402);
    expect(denied.error).toContain('受邀');
    // The decisive assertion: a stranger's request cost the operator nothing.
    expect(client.calls).toEqual({ digest: 0, final: 0 });

    expect((await runJob(app, owner, outline)).status).toBe(202);
  });

  it('still serves a stranger what is already cached, since that costs nothing', async () => {
    const { app, client } = harness(['owner@example.com']);
    const owner = await register(app, 'owner@example.com');
    const stranger = await register(app, 'stranger@example.com');
    await runJob(app, owner, outline);
    const before = { ...client.calls };

    const reused = await runJob(app, stranger, outline);
    expect(reused.cached).toBe(true);
    expect(reused.result).toBeTruthy();
    expect(client.calls).toEqual(before);
  });

  it('admits nobody when the list is empty, and everyone with *', async () => {
    const closed = harness([]);
    const token = await register(closed.app, 'owner@example.com');
    expect((await runJob(closed.app, token, outline)).status).toBe(402);

    const open = harness(['*']);
    const anyone = await register(open.app, 'anyone@example.com');
    expect((await runJob(open.app, anyone, outline)).status).toBe(202);
  });
});
