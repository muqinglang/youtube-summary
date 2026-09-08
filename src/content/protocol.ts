import { z } from 'zod';
import type { CaptionTrack, VideoInfo } from '../shared/types';
import { chaptersFromDescription } from './chapters';

export const REQUEST_CHANNEL = 'sidenote:page-request:v1';
export const RESPONSE_CHANNEL = 'sidenote:page-response:v1';

const idSchema = z.string().uuid();
export const playbackCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('seek'), time: z.number().finite().min(0) }),
  z.object({ action: z.literal('togglePlay') }),
  z.object({ action: z.literal('pause') }),
  z.object({ action: z.literal('speed'), speed: z.number().min(0.25).max(4) }),
]);
const requestSchema = z.object({
  channel: z.literal(REQUEST_CHANNEL),
  id: idSchema,
  request: z.discriminatedUnion('type', [
    z.object({ type: z.literal('video:get') }),
    z.object({ type: z.literal('transcript:get'), trackId: z.string().max(200).optional() }),
    z.object({ type: z.literal('player:command'), command: playbackCommandSchema }),
  ]),
});
const responseSchema = z.object({
  channel: z.literal(RESPONSE_CHANNEL),
  id: idSchema,
  reply: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data: z.unknown() }),
    z.object({ ok: z.literal(false), error: z.string().max(2_000) }),
  ]),
});

export type PageRequest = z.infer<typeof requestSchema>['request'];

export function parsePageRequest(value: unknown) {
  return requestSchema.safeParse(value);
}

export function parsePageResponse(value: unknown) {
  return responseSchema.safeParse(value);
}

export const videoInfoSchema: z.ZodType<VideoInfo> = z.object({
  id: z.string().max(32),
  title: z.string().max(10_000),
  author: z.string().max(2_000),
  url: z.string().max(2_000),
  duration: z.number().finite().min(0),
  currentTime: z.number().finite().min(0),
  paused: z.boolean(),
  tracks: z
    .array(
      z.object({
        id: z.string().max(200),
        language: z.string().max(100),
        name: z.string().max(500),
        automatic: z.boolean(),
      }),
    )
    .max(500),
  chapters: z
    .array(
      z.object({
        title: z.string().min(1).max(500),
        start: z.number().finite().min(0).max(604_800),
      }),
    )
    .max(500)
    .optional(),
});

export const captionResultSchema = z.object({
  videoId: z.string().min(1).max(32),
  language: z.string().max(100),
  raw: z.string().min(1).max(10_000_000),
  coverage: z.enum(['complete', 'unknown']),
});

export interface ResolvedCaptionTrack extends CaptionTrack {
  baseUrl: string;
}

export interface PlayerSnapshot {
  title: string;
  author: string;
  duration: number;
  isLive: boolean;
  tracks: ResolvedCaptionTrack[];
  chapters: NonNullable<VideoInfo['chapters']>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function captionName(value: unknown): string {
  const data = record(value);
  return (
    string(data.simpleText) ||
    (Array.isArray(data.runs)
      ? data.runs.map((run: unknown) => string(record(run).text)).join('')
      : '')
  );
}

/** This is only a public caption URL allowlist, never an arbitrary fetch proxy. */
export function captionUrl(raw: string, videoId: string): string | null {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:' ||
      url.port ||
      url.username ||
      url.password ||
      !['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(url.hostname) ||
      url.pathname !== '/api/timedtext' ||
      url.searchParams.get('v') !== videoId
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

export function videoIdFromUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:' ||
      !['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(url.hostname)
    )
      return null;
    const id =
      url.pathname === '/watch'
        ? url.searchParams.get('v')
        : url.pathname.match(/^\/(?:shorts|live)\/([^/]+)\/?$/)?.[1];
    return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** Ignore the previous video's cached player response during YouTube SPA navigation. */
export function parsePlayerResponse(value: unknown, currentVideoId: string): PlayerSnapshot | null {
  if (typeof value === 'string') {
    if (value.length > 10_000_000) return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const response = record(value);
  const details = record(response.videoDetails);
  if (details.videoId !== currentVideoId) return null;
  const renderer = record(record(response.captions).playerCaptionsTracklistRenderer);
  const tracks: ResolvedCaptionTrack[] = [];
  if (Array.isArray(renderer.captionTracks)) {
    for (const [index, value] of renderer.captionTracks.entries()) {
      const track = record(value);
      const baseUrl = captionUrl(string(track.baseUrl), currentVideoId);
      const language = string(track.languageCode);
      if (!baseUrl || !language) continue;
      tracks.push({
        id: string(track.vssId) || `${language}:${index}`,
        language,
        name: captionName(track.name) || language,
        automatic: track.kind === 'asr',
        baseUrl,
      });
    }
  }
  const duration = Number(details.lengthSeconds);
  return {
    title: string(details.title).slice(0, 10_000),
    author: string(details.author).slice(0, 2_000),
    duration: Number.isFinite(duration) && duration >= 0 ? duration : 0,
    isLive: details.isLiveContent === true,
    tracks,
    chapters: chaptersFromDescription(string(details.shortDescription), duration),
  };
}
