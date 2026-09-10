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
/** A second connection, because the vector table only exists when a dimension is asked for. */
const DIMENSIONS = 64;
let vectorStore: Store | undefined;
async function connectVectors(): Promise<Store> {
  vectorStore ??= await createPostgresStore(url!, {
    embeddingDimensions: DIMENSIONS,
    onNotice: () => undefined,
  });
  return vectorStore;
}
afterAll(async () => {
  await store?.close();
  await vectorStore?.close();
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

when('postgres vectors', () => {
  /**
   * pgvector is an extension and the plain `postgres:16-alpine` image does not carry it, so these
   * assert against whichever image is running: with the extension the vector path is exercised,
   * without it the only correct behaviour is to report the feature as unavailable.
   *
   *   docker run -d --name sidenote-pg -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=sidenote    *     -p 5433:5432 pgvector/pgvector:pg16
   */
  it('either offers a vector store or none at all, never a half-built one', async () => {
    const db = await connectVectors();
    if (!db.chunks) {
      console.warn('数据库没有 pgvector，跳过向量断言。');
      return;
    }
    expect(typeof db.chunks.search).toBe('function');
  });

  it('round-trips chunks and orders them by cosine distance', async () => {
    const db = await connectVectors();
    if (!db.chunks) return;
    const videoId = `video-${unique()}`;
    const source = `stub:${unique()}`;
    const pad = (head: number[]) => [...head, ...Array(DIMENSIONS - head.length).fill(0)];
    await db.chunks.put(videoId, source, [
      { index: 0, start: 0, end: 30, text: '开场白', embedding: pad([1, 0, 0]) },
      { index: 1, start: 30, end: 60, text: '正题', embedding: pad([0, 1, 0]) },
    ]);
    expect(await db.chunks.has(videoId, source)).toBe(true);
    // A different transcript or model produces a different source, which must miss.
    expect(await db.chunks.has(videoId, `other:${unique()}`)).toBe(false);

    const matches = await db.chunks.search([videoId], pad([0, 1, 0]), 5);
    expect(matches).toHaveLength(2);
    expect(matches[0]?.text).toBe('正题');
    expect(matches[0]?.score).toBeCloseTo(1, 5);
    expect(matches[0]?.start).toBe(30);
    // Orthogonal, so it comes last rather than being dropped.
    expect(matches[1]?.score).toBeCloseTo(0, 5);
  });

  it('only searches the videos it is asked about', async () => {
    const db = await connectVectors();
    if (!db.chunks) return;
    const mine = `video-${unique()}`;
    const theirs = `video-${unique()}`;
    const pad = (head: number[]) => [...head, ...Array(DIMENSIONS - head.length).fill(0)];
    await db.chunks.put(mine, 'src', [
      { index: 0, start: 0, end: 1, text: '我的', embedding: pad([1, 0]) },
    ]);
    await db.chunks.put(theirs, 'src', [
      { index: 0, start: 0, end: 1, text: '别人的', embedding: pad([1, 0]) },
    ]);
    const matches = await db.chunks.search([mine], pad([1, 0]), 10);
    expect(matches.map((match) => match.videoId)).toEqual([mine]);
    expect(await db.chunks.search([], pad([1, 0]), 10)).toEqual([]);
  });

  it('replaces a video wholesale when it is re-indexed, leaving no stale rows behind', async () => {
    const db = await connectVectors();
    if (!db.chunks) return;
    const videoId = `video-${unique()}`;
    const pad = (head: number[]) => [...head, ...Array(DIMENSIONS - head.length).fill(0)];
    await db.chunks.put(videoId, 'v1', [
      { index: 0, start: 0, end: 1, text: '旧的第一段', embedding: pad([1, 0]) },
      { index: 1, start: 1, end: 2, text: '旧的第二段', embedding: pad([0, 1]) },
    ]);
    // A shorter transcript: the second row would otherwise survive and be returned forever.
    await db.chunks.put(videoId, 'v2', [
      { index: 0, start: 0, end: 1, text: '新的唯一一段', embedding: pad([1, 0]) },
    ]);
    const matches = await db.chunks.search([videoId], pad([1, 1]), 10);
    expect(matches.map((match) => match.text)).toEqual(['新的唯一一段']);
    expect(await db.chunks.has(videoId, 'v1')).toBe(false);
  });

  it('refuses a dimension the table was not built for, naming the setting to fix', async () => {
    const db = await connectVectors();
    if (!db.chunks) return;
    // Changing SIDENOTE_EMBEDDING_DIMENSIONS against an existing table would otherwise fail on
    // every insert with an error that names neither the setting nor the remedy.
    await expect(
      createPostgresStore(url!, { embeddingDimensions: DIMENSIONS + 1, onNotice: () => undefined }),
    ).rejects.toThrow('SIDENOTE_EMBEDDING_DIMENSIONS');
  });
});
