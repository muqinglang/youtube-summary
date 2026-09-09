import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createPostgresStore } from '../../server/store/postgres';
import type { Store } from '../../server/store/types';

/**
 * Opt-in: these run only when a database is reachable, so the suite stays green on a machine
 * without one. Everything else uses the memory store, which means this file is the only coverage
 * the Postgres implementation gets — run it before deploying.
 *
 *   docker run -d --name sidenote-pg -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=sidenote \
 *     -p 5433:5432 postgres:16-alpine
 *   DATABASE_URL=postgres://postgres:devpass@127.0.0.1:5433/sidenote npm test
 */
const url = process.env.DATABASE_URL;
const when = url ? describe : describe.skip;

let store: Store | undefined;
async function connect(): Promise<Store> {
  store ??= await createPostgresStore(url!);
  return store;
}
afterAll(async () => {
  await store?.close();
});

const unique = () => randomUUID();

when('postgres store', () => {
  it('applies its schema and answers a readiness probe', async () => {
    await expect((await connect()).ping()).resolves.toBeUndefined();
  });

  it('round-trips an account and matches addresses case-insensitively', async () => {
    const db = await connect();
    const email = `user-${unique()}@example.com`;
    const created = await db.users.create(email.toUpperCase(), 'scrypt$hash');
    expect(created.email).toBe(email);
    expect((await db.users.byEmail(email.toUpperCase()))?.id).toBe(created.id);
    expect((await db.users.byId(created.id))?.passwordHash).toBe('scrypt$hash');
    // A token carrying something that is not a uuid must not reach the query as an error.
    await expect(db.users.byId('not-a-uuid')).resolves.toBeUndefined();
  });

  it('stores artifacts by key with equivalent content after the jsonb round-trip', async () => {
    const db = await connect();
    const key = unique();
    const payload = { task: 'outline', outline: { sections: [{ title: '开场', start: 0 }] } };
    await db.artifacts.put({
      key,
      videoId: 'QLLuZbuTIRc',
      task: 'outline',
      payload,
      createdAt: new Date().toISOString(),
    });
    const hit = await db.artifacts.get(key);
    // jsonb sorts object keys, so the bytes differ while the data does not. Nothing reads these
    // payloads positionally, but a byte-for-byte comparison is not a valid invariant here.
    expect(hit?.payload).toEqual(payload);
    expect(hit?.videoId).toBe('QLLuZbuTIRc');
    await expect(db.artifacts.get(unique())).resolves.toBeUndefined();
  });

  it('keeps the first write for a key so a race cannot replace a cached artifact', async () => {
    const db = await connect();
    const key = unique();
    const base = { videoId: 'v', task: 'outline', createdAt: new Date().toISOString() };
    await db.artifacts.put({ ...base, key, payload: { first: true } });
    await db.artifacts.put({ ...base, key, payload: { second: true } });
    expect((await db.artifacts.get(key))?.payload).toEqual({ first: true });
  });

  it('shares digests by key, which is what makes a second task nearly free', async () => {
    const db = await connect();
    const key = unique();
    const digest = { overview: '片段摘要', notes: [{ start: 12.5, text: '一条要点' }] };
    await db.digests.set(key, digest);
    expect(await db.digests.get(key)).toEqual(digest);
    await expect(db.digests.get(unique())).resolves.toBeUndefined();
  });

  it('counts usage per account per day', async () => {
    const db = await connect();
    const user = await db.users.create(`usage-${unique()}@example.com`, 'scrypt$hash');
    const day = '2026-09-09';
    expect(await db.usage.jobsToday(user.id, day)).toBe(0);
    expect(await db.usage.recordJob(user.id, day)).toBe(1);
    expect(await db.usage.recordJob(user.id, day)).toBe(2);
    expect(await db.usage.jobsToday(user.id, day)).toBe(2);
    // A different day starts over rather than inheriting the total.
    expect(await db.usage.jobsToday(user.id, '2026-09-10')).toBe(0);
  });

  it('records a library without duplicating a repeated video', async () => {
    const db = await connect();
    const user = await db.users.create(`library-${unique()}@example.com`, 'scrypt$hash');
    await db.library.add(user.id, 'video-a');
    await db.library.add(user.id, 'video-a');
    await db.library.add(user.id, 'video-b');
    expect((await db.library.list(user.id)).sort()).toEqual(['video-a', 'video-b']);
  });

  it('replaces a transcript when the same track is read again', async () => {
    const db = await connect();
    const videoId = `video-${unique()}`;
    const record = {
      videoId,
      trackId: 'en',
      language: 'en',
      source: 'youtube' as const,
      coverage: 'complete' as const,
      cues: [{ id: 'a', start: 0, end: 2, text: 'First' }],
    };
    await db.transcripts.put(record);
    await db.transcripts.put({ ...record, cues: [{ id: 'a', start: 0, end: 2, text: 'Second' }] });
    expect((await db.transcripts.get(videoId, 'en'))?.cues[0]?.text).toBe('Second');
  });
});
