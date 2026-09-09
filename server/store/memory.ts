import { randomUUID } from 'node:crypto';
import type { Digest } from '../../src/background/validation';
import type { ArtifactRecord, Store, TranscriptRecord, UserRecord, VideoRecord } from './types';

/** Backs tests and local development so the whole service runs without a database. */
export function createMemoryStore(): Store {
  const users = new Map<string, UserRecord>();
  const byEmail = new Map<string, string>();
  const videos = new Map<string, VideoRecord>();
  const transcripts = new Map<string, TranscriptRecord>();
  const artifacts = new Map<string, ArtifactRecord>();
  const digests = new Map<string, Digest>();
  const jobs = new Map<string, number>();
  const library = new Map<string, Set<string>>();

  return {
    users: {
      create: async (email, passwordHash) => {
        const normalized = email.toLowerCase();
        if (byEmail.has(normalized)) throw new Error('该邮箱已注册。');
        const user: UserRecord = {
          id: randomUUID(),
          email: normalized,
          passwordHash,
          createdAt: new Date().toISOString(),
        };
        users.set(user.id, user);
        byEmail.set(normalized, user.id);
        return user;
      },
      byEmail: async (email) => {
        const id = byEmail.get(email.toLowerCase());
        return id ? users.get(id) : undefined;
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
    ping: async () => undefined,
    close: async () => undefined,
  };
}
