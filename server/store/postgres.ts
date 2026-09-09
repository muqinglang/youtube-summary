import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import type { Digest } from '../../src/background/validation';
import type { ArtifactRecord, Store, TranscriptRecord, UserRecord, VideoRecord } from './types';

/** Arbitrary but fixed: any process applying this schema takes the same lock. */
const SCHEMA_LOCK = 8_027_314_155_001;

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: Date;
}

function toUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    createdAt: row.created_at.toISOString(),
  };
}

export async function createPostgresStore(connectionString: string): Promise<Store> {
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

  return {
    users: {
      create: async (email, passwordHash) => {
        const { rows } = await pool.query<UserRow>(
          `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3) RETURNING *`,
          [randomUUID(), email.toLowerCase(), passwordHash],
        );
        return toUser(rows[0]!);
      },
      byEmail: async (email) => {
        const { rows } = await pool.query<UserRow>(`SELECT * FROM users WHERE email = $1`, [
          email.toLowerCase(),
        ]);
        return rows[0] ? toUser(rows[0]) : undefined;
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
    ping: async () => {
      await pool.query('SELECT 1');
    },
    close: async () => {
      await pool.end();
    },
  };
}
