import { randomUUID } from 'node:crypto';
import type { Digest } from '../../src/background/validation';
import { cosineSimilarity } from '../ai/embeddings';
import type {
  ArtifactRecord,
  ChunkMatch,
  ChunkRecord,
  Store,
  TranscriptRecord,
  UserRecord,
  VideoRecord,
} from './types';

/** Backs tests and local development so the whole service runs without a database. */
export function createMemoryStore(): Store {
  const users = new Map<string, UserRecord>();
  const byGoogle = new Map<string, string>();
  const videos = new Map<string, VideoRecord>();
  const transcripts = new Map<string, TranscriptRecord>();
  const artifacts = new Map<string, ArtifactRecord>();
  const digests = new Map<string, Digest>();
  const jobs = new Map<string, number>();
  const library = new Map<string, Set<string>>();
  const chunks = new Map<string, { source: string; rows: ChunkRecord[] }>();

  return {
    users: {
      fromGoogle: async (subject, email) => {
        const existing = byGoogle.get(subject);
        if (existing) {
          const user = { ...users.get(existing)!, email: email.toLowerCase() };
          users.set(user.id, user);
          return user;
        }
        const user: UserRecord = {
          id: randomUUID(),
          email: email.toLowerCase(),
          googleSub: subject,
          createdAt: new Date().toISOString(),
        };
        users.set(user.id, user);
        byGoogle.set(subject, user.id);
        return user;
      },
      byId: async (id) => users.get(id),
    },
    videos: {
      upsert: async (video) => {
        videos.set(video.videoId, video);
      },
      get: async (videoId) => videos.get(videoId),
    },
    transcripts: {
      put: async (transcript) => {
        transcripts.set(`${transcript.videoId}::${transcript.trackId}`, transcript);
      },
      get: async (videoId, trackId) => transcripts.get(`${videoId}::${trackId}`),
    },
    artifacts: {
      get: async (key) => artifacts.get(key),
      put: async (artifact) => {
        artifacts.set(artifact.key, artifact);
      },
    },
    digests: {
      get: async (key) => digests.get(key),
      set: async (key, digest) => {
        digests.set(key, digest);
      },
    },
    usage: {
      recordJob: async (userId, day) => {
        const key = `${userId}::${day}`;
        const next = (jobs.get(key) ?? 0) + 1;
        jobs.set(key, next);
        return next;
      },
      jobsToday: async (userId, day) => jobs.get(`${userId}::${day}`) ?? 0,
    },
    library: {
      add: async (userId, videoId) => {
        const owned = library.get(userId) ?? new Set<string>();
        owned.add(videoId);
        library.set(userId, owned);
      },
      list: async (userId) => [...(library.get(userId) ?? [])],
    },
    chunks: {
      has: async (videoId, source) => chunks.get(videoId)?.source === source,
      put: async (videoId, source, rows) => {
        chunks.set(videoId, { source, rows });
      },
      search: async (videoIds, embedding, limit) => {
        const wanted = new Set(videoIds);
        const matches: ChunkMatch[] = [];
        for (const [videoId, entry] of chunks) {
          if (!wanted.has(videoId)) continue;
          for (const row of entry.rows)
            matches.push({
              videoId,
              start: row.start,
              end: row.end,
              text: row.text,
              score: cosineSimilarity(embedding, row.embedding),
            });
        }
        // Exhaustive rather than indexed: correct by construction, and the volumes this store
        // ever holds are a test fixture or one developer's local library.
        return matches.sort((a, b) => b.score - a.score).slice(0, limit);
      },
    },
    ping: async () => undefined,
    close: async () => undefined,
  };
}
