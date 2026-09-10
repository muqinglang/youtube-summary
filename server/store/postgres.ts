import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import type { Digest } from '../../src/background/validation';
import type {
  ArtifactRecord,
  ChunkStore,
  Store,
  TranscriptRecord,
  UserRecord,
  VideoRecord,
} from './types';

/** Arbitrary but fixed: any process applying this schema takes the same lock. */
const SCHEMA_LOCK = 8_027_314_155_001;
/** One statement per this many vectors, so a long video does not build a single vast query. */
const INSERT_BATCH = 100;

export interface PostgresOptions {
  /** Enables the vector table. Omitted leaves `store.chunks` undefined and the feature off. */
  embeddingDimensions?: number;
  onNotice?: (message: string) => void;
}

/**
 * pgvector is an extension, and plenty of managed Postgres offerings either lack it or refuse
 * `CREATE EXTENSION` to the application role. That is a configuration to report, not a crash: the
 * rest of the service does not depend on it, so an unavailable extension returns undefined and
 * cross-video search reports itself unavailable.
 */
async function createChunkStore(
  pool: Pool,
  dimensions: number,
  notice: (message: string) => void,
): Promise<ChunkStore | undefined> {
  // Reaches a DDL statement as a literal; the config layer checks it too, but not this file's
  // caller in a test, so it is re-checked at the point where it becomes SQL.
  if (!Number.isInteger(dimensions) || dimensions < 64 || dimensions > 4096)
    throw new Error('向量维度必须是 64 到 4096 之间的整数。');
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  } catch {
    notice('数据库没有 pgvector 扩展，跨视频知识库已关闭。');
    return undefined;
  }
  await pool.query(`CREATE TABLE IF NOT EXISTS chunks (
      video_id  text NOT NULL,
      source    text NOT NULL,
      idx       integer NOT NULL,
      start_at  double precision NOT NULL,
      end_at    double precision NOT NULL,
      text      text NOT NULL,
      embedding vector(${dimensions}) NOT NULL,
      PRIMARY KEY (video_id, idx)
    )`);
  // An existing table at another dimension would accept nothing we insert, and the error it
  // raises names neither the setting nor the fix.
  const { rows } = await pool.query<{ type: string }>(
    `SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
     WHERE attrelid = 'chunks'::regclass AND attname = 'embedding'`,
  );
  const actual = rows[0]?.type;
  if (actual !== `vector(${dimensions})`)
    throw new Error(
      `chunks.embedding 是 ${actual ?? '未知类型'}，与配置的 vector(${dimensions}) 不符：` +
        '请把 SIDENOTE_EMBEDDING_DIMENSIONS 改回原值，或先 DROP TABLE chunks 重新索引。',
    );
  // hnsw needs pgvector 0.5+. An older build takes ivfflat, and one that takes neither still
  // answers correctly by scanning — slower, but never wrong.
  let indexed = false;
  for (const method of ['hnsw', 'ivfflat']) {
    try {
      await pool.query(
        `CREATE INDEX IF NOT EXISTS chunks_embedding ON chunks USING ${method} (embedding vector_cosine_ops)`,
      );
      indexed = true;
      break;
    } catch {
      indexed = false;
    }
  }
  if (!indexed) notice('无法建立向量索引，检索改为全表扫描，数据量大时会变慢。');

  return {
    has: async (videoId, source) => {
      const { rows: found } = await pool.query(
        `SELECT 1 FROM chunks WHERE video_id = $1 AND source = $2 LIMIT 1`,
        [videoId, source],
      );
      return found.length > 0;
    },
    put: async (videoId, source, entries) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Replace wholesale: a re-index at a new source must not leave the old vectors behind,
        // and the primary key is (video_id, idx) so a shorter transcript would strand rows.
        await client.query(`DELETE FROM chunks WHERE video_id = $1`, [videoId]);
        for (let start = 0; start < entries.length; start += INSERT_BATCH) {
          const params: unknown[] = [videoId, source];
          const values = entries
            .slice(start, start + INSERT_BATCH)
            .map((entry) => {
              const base = params.length;
              // pgvector parses the same bracketed list JSON produces, so no encoder is needed.
              params.push(
                entry.index,
                entry.start,
                entry.end,
                entry.text,
                JSON.stringify(entry.embedding),
              );
              return `($1, $2, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::vector)`;
            })
            .join(', ');
          await client.query(
            `INSERT INTO chunks (video_id, source, idx, start_at, end_at, text, embedding)
             VALUES ${values}`,
            params,
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    search: async (videoIds, embedding, limit) => {
      if (!videoIds.length) return [];
      const { rows: found } = await pool.query<{
        video_id: string;
        start_at: string;
        end_at: string;
        text: string;
        score: string;
      }>(
        `SELECT video_id, start_at, end_at, text, 1 - (embedding <=> $1::vector) AS score
         FROM chunks WHERE video_id = ANY($2::text[])
         ORDER BY embedding <=> $1::vector LIMIT $3`,
        [JSON.stringify(embedding), videoIds, limit],
      );
      return found.map((row) => ({
        videoId: row.video_id,
        start: Number(row.start_at),
        end: Number(row.end_at),
        text: row.text,
        score: Number(row.score),
      }));
    },
  };
}

interface UserRow {
  id: string;
  email: string;
  google_sub: string;
  created_at: Date;
}

function toUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    googleSub: row.google_sub,
    createdAt: row.created_at.toISOString(),
  };
}

export async function createPostgresStore(
  connectionString: string,
  options: PostgresOptions = {},
): Promise<Store> {
  const pool = new Pool({ connectionString });
  const schema = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), 'schema.sql'),
    'utf8',
  );
  // Two instances booting together would otherwise race on CREATE TABLE; the advisory lock
  // serialises them. It is not a migration system — see the deployment notes before evolving
  // the schema in place.
  const migration = await pool.connect();
  try {
    await migration.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK]);
    await migration.query(schema);
  } finally {
    await migration.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]);
    migration.release();
  }
  const notice = options.onNotice ?? ((message: string) => console.warn(message));
  let chunks: ChunkStore | undefined;
  try {
    chunks = options.embeddingDimensions
      ? await createChunkStore(pool, options.embeddingDimensions, notice)
      : undefined;
  } catch (error) {
    // Nothing owns the pool yet, so a failure here would otherwise strand its connections.
    await pool.end();
    throw error;
  }

  return {
    users: {
      fromGoogle: async (subject, email) => {
        // One statement, so two sign-ins racing on a first visit cannot both insert.
        const { rows } = await pool.query<UserRow>(
          `INSERT INTO users (id, google_sub, email) VALUES ($1, $2, $3)
           ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email RETURNING *`,
          [randomUUID(), subject, email.toLowerCase()],
        );
        return toUser(rows[0]!);
      },
      byId: async (id) => {
        // Session tokens carry a uuid; a malformed one must not surface as a 500.
        if (!/^[\da-f-]{36}$/i.test(id)) return undefined;
        const { rows } = await pool.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [id]);
        return rows[0] ? toUser(rows[0]) : undefined;
      },
    },
    videos: {
      upsert: async (video) => {
        await pool.query(
          `INSERT INTO videos (video_id, title, author, url, duration) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (video_id) DO UPDATE SET title = EXCLUDED.title, author = EXCLUDED.author,
             url = EXCLUDED.url, duration = EXCLUDED.duration`,
          [video.videoId, video.title, video.author, video.url, video.duration],
        );
      },
      get: async (videoId) => {
        const { rows } = await pool.query<VideoRecord & { video_id: string }>(
          `SELECT video_id, title, author, url, duration FROM videos WHERE video_id = $1`,
          [videoId],
        );
        const row = rows[0];
        return row
          ? {
              videoId: row.video_id,
              title: row.title,
              author: row.author,
              url: row.url,
              duration: Number(row.duration),
            }
          : undefined;
      },
    },
    transcripts: {
      put: async (transcript) => {
        await pool.query(
          `INSERT INTO transcripts (video_id, track_id, language, source, coverage, cues)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (video_id, track_id) DO UPDATE SET language = EXCLUDED.language,
             source = EXCLUDED.source, coverage = EXCLUDED.coverage, cues = EXCLUDED.cues,
             updated_at = now()`,
          [
            transcript.videoId,
            transcript.trackId,
            transcript.language,
            transcript.source,
            transcript.coverage,
            JSON.stringify(transcript.cues),
          ],
        );
      },
      get: async (videoId, trackId) => {
        const { rows } = await pool.query<
          TranscriptRecord & { video_id: string; track_id: string }
        >(
          `SELECT video_id, track_id, language, source, coverage, cues FROM transcripts
           WHERE video_id = $1 AND track_id = $2`,
          [videoId, trackId],
        );
        const row = rows[0];
        return row
          ? {
              videoId: row.video_id,
              trackId: row.track_id,
              language: row.language,
              source: row.source,
              coverage: row.coverage,
              cues: row.cues,
            }
          : undefined;
      },
    },
    artifacts: {
      get: async (key) => {
        const { rows } = await pool.query<{
          key: string;
          video_id: string;
          task: string;
          payload: unknown;
          notice: string | null;
          created_at: Date;
        }>(`SELECT * FROM artifacts WHERE key = $1`, [key]);
        const row = rows[0];
        return row
          ? {
              key: row.key,
              videoId: row.video_id,
              task: row.task,
              payload: row.payload,
              ...(row.notice ? { notice: row.notice } : {}),
              createdAt: row.created_at.toISOString(),
            }
          : undefined;
      },
      put: async (artifact: ArtifactRecord) => {
        await pool.query(
          `INSERT INTO artifacts (key, video_id, task, payload, notice) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (key) DO NOTHING`,
          [
            artifact.key,
            artifact.videoId,
            artifact.task,
            JSON.stringify(artifact.payload),
            artifact.notice ?? null,
          ],
        );
      },
    },
    digests: {
      get: async (key) => {
        const { rows } = await pool.query<{ payload: Digest }>(
          `SELECT payload FROM digests WHERE key = $1`,
          [key],
        );
        return rows[0]?.payload;
      },
      set: async (key, digest) => {
        await pool.query(
          `INSERT INTO digests (key, payload) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
          [key, JSON.stringify(digest)],
        );
      },
    },
    usage: {
      recordJob: async (userId, day) => {
        const { rows } = await pool.query<{ jobs: number }>(
          `INSERT INTO usage_jobs (user_id, day, jobs) VALUES ($1, $2, 1)
           ON CONFLICT (user_id, day) DO UPDATE SET jobs = usage_jobs.jobs + 1 RETURNING jobs`,
          [userId, day],
        );
        return rows[0]?.jobs ?? 1;
      },
      jobsToday: async (userId, day) => {
        const { rows } = await pool.query<{ jobs: number }>(
          `SELECT jobs FROM usage_jobs WHERE user_id = $1 AND day = $2`,
          [userId, day],
        );
        return rows[0]?.jobs ?? 0;
      },
    },
    library: {
      add: async (userId, videoId) => {
        await pool.query(
          `INSERT INTO library (user_id, video_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [userId, videoId],
        );
      },
      list: async (userId) => {
        const { rows } = await pool.query<{ video_id: string }>(
          `SELECT video_id FROM library WHERE user_id = $1 ORDER BY added_at DESC`,
          [userId],
        );
        return rows.map((row) => row.video_id);
      },
    },
    ...(chunks ? { chunks } : {}),
    ping: async () => {
      await pool.query('SELECT 1');
    },
    close: async () => {
      await pool.end();
    },
  };
}
