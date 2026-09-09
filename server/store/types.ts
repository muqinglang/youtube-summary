import type { Cue } from '../../src/shared/types';
import type { DigestStore } from '../../src/background/ai-service';

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
}

export interface VideoRecord {
  videoId: string;
  title: string;
  author: string;
  url: string;
  duration: number;
}

export interface TranscriptRecord {
  videoId: string;
  trackId: string;
  language: string;
  source: 'youtube' | 'import';
  coverage: 'complete' | 'unknown';
  cues: Cue[];
}

export interface ArtifactRecord {
  key: string;
  videoId: string;
  task: string;
  payload: unknown;
  notice?: string;
  createdAt: string;
}

/**
 * Two tiers on purpose. Everything derived from a video is keyed by the video and shared by every
 * account, which is what makes a second viewer of the same video nearly free. Only what belongs to
 * a person — their library and their usage — is partitioned by user.
 */
export interface Store {
  users: {
    create(email: string, passwordHash: string): Promise<UserRecord>;
    byEmail(email: string): Promise<UserRecord | undefined>;
    byId(id: string): Promise<UserRecord | undefined>;
  };
  videos: {
    upsert(video: VideoRecord): Promise<void>;
    get(videoId: string): Promise<VideoRecord | undefined>;
  };
  transcripts: {
    put(transcript: TranscriptRecord): Promise<void>;
    get(videoId: string, trackId: string): Promise<TranscriptRecord | undefined>;
  };
  artifacts: {
    get(key: string): Promise<ArtifactRecord | undefined>;
    put(artifact: ArtifactRecord): Promise<void>;
  };
  /** Fragment digests, shared across users and across the tasks that read identical evidence. */
  digests: DigestStore;
  usage: {
    /** Returns the running total for the day after recording, so callers can enforce a limit. */
    recordJob(userId: string, day: string): Promise<number>;
    jobsToday(userId: string, day: string): Promise<number>;
  };
  library: {
    add(userId: string, videoId: string): Promise<void>;
    list(userId: string): Promise<string[]>;
  };
  /** Proves the backing store is reachable; a readiness probe must not pass without it. */
  ping(): Promise<void>;
  close(): Promise<void>;
}
