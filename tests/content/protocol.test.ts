import { describe, expect, it } from 'vitest';
import {
  captionResultSchema,
  captionUrl,
  parsePageRequest,
  parsePageResponse,
  parsePlayerResponse,
  REQUEST_CHANNEL,
  RESPONSE_CHANNEL,
  videoIdFromUrl,
  videoInfoSchema,
} from '../../src/content/protocol';

const videoId = 'dQw4w9WgXcQ';
const requestId = '939c31bf-5e2c-4ea6-af14-d2885c3c1022';
const baseUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&signature=preserve-me`;
const playerResponse = {
  videoDetails: { videoId, title: 'A title', author: 'Channel', lengthSeconds: '360' },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        { baseUrl, languageCode: 'en', name: { runs: [{ text: 'English' }] }, vssId: '.en' },
        {
          baseUrl: baseUrl.replace('lang=en', 'lang=zh'),
          languageCode: 'zh',
          name: { simpleText: '中文' },
          kind: 'asr',
          vssId: 'a.zh',
        },
      ],
    },
  },
};

describe('public YouTube caption URL validation', () => {
  it('preserves the signed caption URL without adding a format parameter', () => {
    const url = new URL(captionUrl(baseUrl, videoId)!);
    expect(url.searchParams.get('signature')).toBe('preserve-me');
    expect(url.searchParams.get('fmt')).toBeNull();
    expect(url.searchParams.get('v')).toBe(videoId);
    expect(captionUrl(baseUrl + '&fmt=srv3', videoId)).toBe(baseUrl + '&fmt=srv3');
  });

  it.each([
    'https://attacker.example/api/timedtext',
    'https://youtube.com.attacker.example/api/timedtext',
    'https://www.youtube.com/redirect',
    'http://www.youtube.com/api/timedtext',
    'https://name:password@www.youtube.com/api/timedtext',
    'https://www.youtube.com:8443/api/timedtext',
    'file:///api/timedtext',
  ])('rejects arbitrary request target %s', (url) => {
    expect(captionUrl(`${url}?v=${videoId}`, videoId)).toBeNull();
  });

  it('rejects stale caption URLs belonging to another video', () => {
    expect(captionUrl(baseUrl, 'abcdefghijk')).toBeNull();
    expect(captionUrl('https://www.youtube.com/api/timedtext?lang=en', videoId)).toBeNull();
  });
});

describe('player response discovery', () => {
  it('reads bounded JSON string responses and ignores malformed responses', () => {
    expect(parsePlayerResponse(JSON.stringify(playerResponse), videoId)?.tracks).toHaveLength(2);
    expect(parsePlayerResponse('{invalid}', videoId)).toBeNull();
  });
  it('reads native tracks and marks automatic captions separately', () => {
    const snapshot = parsePlayerResponse(playerResponse, videoId);
    expect(snapshot).toMatchObject({ title: 'A title', author: 'Channel', duration: 360 });
    expect(snapshot?.tracks).toHaveLength(2);
    expect(snapshot?.tracks[0]).toMatchObject({ id: '.en', name: 'English', automatic: false });
    expect(snapshot?.tracks[1]).toMatchObject({ id: 'a.zh', name: '中文', automatic: true });
  });

  it('does not reuse the last video response after SPA navigation', () => {
    expect(parsePlayerResponse(playerResponse, 'abcdefghijk')).toBeNull();
    expect(parsePlayerResponse(undefined, videoId)).toBeNull();
  });

  it('handles videos without caption tracks and invalid durations truthfully', () => {
    expect(
      parsePlayerResponse({ videoDetails: { videoId, lengthSeconds: 'NaN' } }, videoId),
    ).toEqual({ title: '', author: '', duration: 0, isLive: false, tracks: [], chapters: [] });
  });

  it('discards tracks that would fetch foreign hosts', () => {
    const response = structuredClone(playerResponse);
    response.captions.playerCaptionsTracklistRenderer.captionTracks[0]!.baseUrl =
      'https://attacker.example/secrets';
    expect(parsePlayerResponse(response, videoId)?.tracks).toHaveLength(1);
  });

  it('marks live sources so downstream summaries do not claim complete coverage', () => {
    expect(
      parsePlayerResponse({ videoDetails: { videoId, isLiveContent: true } }, videoId)?.isLive,
    ).toBe(true);
  });
});

describe('video URL routing', () => {
  it.each([
    `https://www.youtube.com/watch?v=${videoId}&t=6`,
    `https://m.youtube.com/watch?v=${videoId}`,
    `https://www.youtube.com/shorts/${videoId}`,
    `https://www.youtube.com/live/${videoId}`,
  ])('recognizes the current video from %s', (url) => expect(videoIdFromUrl(url)).toBe(videoId));

  it.each([
    'https://www.youtube.com/',
    `https://evil.example/watch?v=${videoId}`,
    'https://www.youtube.com/watch?v=bad',
    `https://www.youtube.com/playlist?v=${videoId}`,
    `javascript://www.youtube.com/watch?v=${videoId}`,
  ])('does not mistake %s for a watch page', (url) => expect(videoIdFromUrl(url)).toBeNull());
});

describe('unprivileged page bridge', () => {
  const request = (body: unknown) =>
    parsePageRequest({ channel: REQUEST_CHANNEL, id: requestId, request: body });

  it('allows only caption retrieval, video state, and bounded playback commands', () => {
    expect(request({ type: 'video:get' }).success).toBe(true);
    expect(request({ type: 'transcript:get', trackId: '.en' }).success).toBe(true);
    expect(
      request({ type: 'player:command', command: { action: 'seek', time: 12.2 } }).success,
    ).toBe(true);
    expect(
      request({ type: 'player:command', command: { action: 'speed', speed: 1.5 } }).success,
    ).toBe(true);
  });

  it.each([
    { type: 'settings:get' },
    { type: 'settings:save', settings: { apiKey: 'page-key' } },
    { type: 'ai:run' },
    { type: 'fetch', url: 'https://attacker.example' },
    { type: 'player:command', command: { action: 'overlay', original: '<script>' } },
    { type: 'player:command', command: { action: 'seek', time: -1 } },
    { type: 'player:command', command: { action: 'seek', time: Infinity } },
    { type: 'player:command', command: { action: 'speed', speed: 100 } },
  ])('rejects privileged or malformed payload %j', (body) =>
    expect(request(body).success).toBe(false),
  );

  it('requires the correct protocol version and request id', () => {
    expect(
      parsePageRequest({ channel: 'other', id: requestId, request: { type: 'video:get' } }).success,
    ).toBe(false);
    expect(
      parsePageResponse({
        channel: RESPONSE_CHANNEL,
        id: 'guessed',
        reply: { ok: true, data: null },
      }).success,
    ).toBe(false);
    expect(
      parsePageResponse({
        channel: RESPONSE_CHANNEL,
        id: requestId,
        reply: { ok: false, error: 'Failed' },
      }).success,
    ).toBe(true);
  });

  it('validates page data again before it reaches the extension panel', () => {
    expect(videoInfoSchema.safeParse({ id: videoId, duration: Infinity }).success).toBe(false);
    expect(
      captionResultSchema.safeParse({ videoId, language: 'en', raw: '', coverage: 'complete' })
        .success,
    ).toBe(false);
    expect(
      captionResultSchema.safeParse({
        videoId,
        language: 'en',
        raw: '{"events":[]}',
        coverage: 'complete',
      }).success,
    ).toBe(true);
  });
});
