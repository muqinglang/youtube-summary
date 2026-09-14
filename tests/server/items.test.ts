import { describe, expect, it } from 'vitest';
import { createHarness, register } from './harness';

type App = ReturnType<typeof createHarness>['app'];
const NOTES = 'notes:QLLuZbuTIRc';

function save(app: App, token: string, key: string, value: unknown, updatedAt: number) {
  return app.inject({
    method: 'POST',
    url: `/v1/items/${encodeURIComponent(key)}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { value, updatedAt },
  });
}

async function load(app: App, token: string, key: string) {
  const response = await app.inject({
    method: 'GET',
    url: `/v1/items/${encodeURIComponent(key)}`,
    headers: { authorization: `Bearer ${token}` },
  });
  return response.json<{ item: { value: unknown; updatedAt: number } | null }>().item;
}

describe('what an account keeps', () => {
  it('gives each account its own copy and shows it to nobody else', async () => {
    const { app } = createHarness();
    const owner = await register(app, 'owner@example.com');
    const other = await register(app, 'other@example.com');
    const notes = [{ id: 'a', start: 12, text: 'Check evidence.' }];

    expect((await save(app, owner, NOTES, notes, 100)).json()).toEqual({ saved: true });
    expect(await load(app, owner, NOTES)).toEqual({ value: notes, updatedAt: 100 });
    expect(await load(app, other, NOTES)).toBeNull();
  });

  it('keeps the newer copy when an older one arrives late', async () => {
    const { app } = createHarness();
    const token = await register(app, 'owner@example.com');
    await save(app, token, NOTES, ['newer'], 200);
    // A retry from before the edit is a valid request, but it must not undo the edit.
    expect((await save(app, token, NOTES, ['older'], 150)).json()).toEqual({ saved: false });
    expect((await load(app, token, NOTES))?.value).toEqual(['newer']);
  });

  it('refuses a missing session, a key that is not an item and a clock far ahead', async () => {
    const { app } = createHarness();
    const token = await register(app, 'owner@example.com');
    const anonymous = await app.inject({ method: 'GET', url: `/v1/items/${NOTES}` });
    expect(anonymous.statusCode).toBe(401);
    expect((await save(app, token, '../users', [], 1)).statusCode).toBe(400);
    expect((await save(app, token, NOTES, [], Date.now() + 2 * 86_400_000)).statusCode).toBe(400);
    const missing = await app.inject({
      method: 'POST',
      url: `/v1/items/${NOTES}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { updatedAt: 1 },
    });
    expect(missing.statusCode).toBe(400);
  });

  it('stops an account at its storage limit instead of growing without bound', async () => {
    const { app } = createHarness();
    const token = await register(app, 'owner@example.com');
    const large = 'x'.repeat(1_000_000);
    for (let index = 0; index < 20; index += 1)
      expect((await save(app, token, `learning:item${index}`, large, 1)).statusCode).toBe(200);
    const full = await save(app, token, 'learning:item20', large, 1);
    expect(full.statusCode).toBe(413);
    expect(full.json<{ error: string }>().error).toContain('已满');
    // Replacing something already kept is not growth, so it still goes through.
    expect((await save(app, token, 'learning:item0', 'smaller', 2)).json()).toEqual({ saved: true });
    expect((await save(app, token, 'learning:big', 'x'.repeat(1_100_000), 1)).statusCode).toBe(413);
  });
});
