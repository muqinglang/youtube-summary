import '../shared/zod-setup';
import type { Reply, VideoInfo } from '../shared/types';
import { parseTranscript } from '../core/transcript';
import { installCaptionCapture } from './caption-capture';
import { readNativeTranscript } from './native-transcript';
import { captionsViaPlayer, type CaptionPlayer } from './player-captions';
import { extractVideoChapters } from './chapters';
import {
  parsePageRequest,
  parsePlayerResponse,
  RESPONSE_CHANNEL,
  videoIdFromUrl,
  type PageRequest,
  type PlayerSnapshot,
} from './protocol';

interface YouTubePlayer extends HTMLElement, CaptionPlayer {
  getPlayerResponse?: () => unknown;
}

const pageWindow = window as Window & {
  ytInitialPlayerResponse?: unknown;
  ytInitialData?: unknown;
  ytplayer?: { config?: { args?: { player_response?: unknown; raw_player_response?: unknown } } };
};
const capture = installCaptionCapture();
const activeFetches = new Set<AbortController>();
let lastContentVideo: VideoInfo | null = null;
let lastSnapshot: { id: string; data: PlayerSnapshot } | undefined;

function isAdPlaying(): boolean {
  return Boolean(document.querySelector('#movie_player.ad-showing, #movie_player.ad-interrupting'));
}

function getSnapshot(): { id: string; data: PlayerSnapshot | null } {
  const id = videoIdFromUrl(location.href);
  if (!id) throw new Error('请在 YouTube 视频播放页打开旁听。');
  const player = document.querySelector<YouTubePlayer>('#movie_player');
  let playerData: unknown;
  try {
    playerData = player?.getPlayerResponse?.();
  } catch {
    /* Player can be between SPA states. */
  }
  const element = document.querySelector('ytd-player') as
    (Element & { playerResponse?: unknown; __data?: { playerResponse?: unknown } }) | null;
  const args = pageWindow.ytplayer?.config?.args;
  const candidates = [
    playerData,
    pageWindow.ytInitialPlayerResponse,
    args?.raw_player_response,
    args?.player_response,
    element?.playerResponse,
    element?.__data?.playerResponse,
  ]
    .map((value) => parsePlayerResponse(value, id))
    .filter((value): value is PlayerSnapshot => value !== null);
  const data = candidates.find((value) => value.tracks.length) || candidates[0];
  const previous = lastSnapshot?.id === id ? lastSnapshot.data : undefined;
  const descriptionChapters = candidates.find((value) => value.chapters.length)?.chapters || [];
  const nativeChapters = data
    ? extractVideoChapters(pageWindow.ytInitialData, id, data.duration)
    : [];
  if (data)
    lastSnapshot = {
      id,
      data: {
        ...data,
        tracks: data.tracks.length ? data.tracks : previous?.tracks || [],
        chapters: nativeChapters.length
          ? nativeChapters
          : descriptionChapters.length
            ? descriptionChapters
            : previous?.chapters || [],
      },
    };
  else if (!previous) lastSnapshot = undefined;
  return { id, data: lastSnapshot?.id === id ? lastSnapshot.data : null };
}

function getVideo(): VideoInfo {
  const { id, data } = getSnapshot();
  const advertising = isAdPlaying();
  const previous = lastContentVideo?.id === id ? lastContentVideo : null;
  const video = document.querySelector<HTMLVideoElement>(
    '#movie_player video, video.html5-main-video',
  );
  const result: VideoInfo = {
    id,
    title: data?.title || previous?.title || document.title.replace(/ - YouTube$/, ''),
    author: data?.author || previous?.author || '',
    url: `https://www.youtube.com/watch?v=${id}`,
    duration: advertising
      ? data?.duration || previous?.duration || 0
      : video && Number.isFinite(video.duration)
        ? video.duration
        : data?.duration || 0,
    currentTime: advertising
      ? previous?.currentTime || 0
      : video && Number.isFinite(video.currentTime)
        ? video.currentTime
        : 0,
    paused: advertising || (video?.paused ?? true),
    tracks: data?.tracks.map(({ baseUrl: _baseUrl, ...track }) => track) || previous?.tracks || [],
    chapters: data?.chapters || previous?.chapters || [],
  };
  if (!advertising) lastContentVideo = result;
  return result;
}

async function getTranscript(trackId?: string) {
  const { id, data } = getSnapshot();
  const tracks = data?.tracks || [];
  const track = trackId
    ? tracks.find((item) => item.id === trackId)
    : tracks.find((item) => !item.automatic) || tracks[0];
  const controller = new AbortController();
  activeFetches.add(controller);
  const timeout = setTimeout(() => controller.abort(), 28_000);
  try {
    const cached = capture.get(id, track);
    if (cached && (!trackId || track)) return cached;
    if (track) {
      try {
        // Preserve YouTube's signed URL. Format changes can invalidate a native request.
        const response = await fetch(track.baseUrl, {
          credentials: 'same-origin',
          redirect: 'error',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(6000)]),
        });
        if (!response.ok || Number(response.headers.get('content-length')) > 10_000_000)
          throw new Error('字幕接口未返回有效内容');
        const raw = await response.text();
        if (!raw.trim() || raw.length > 10_000_000 || !parseTranscript(raw).length)
          throw new Error('字幕接口返回空正文');
        if (videoIdFromUrl(location.href) !== id) throw new Error('视频已切换');
        return {
          videoId: id,
          language: track.language,
          raw,
          coverage: data?.isLive ? 'unknown' : 'complete',
        };
      } catch {
        // An empty 200 is what a fetch without the player's proof-of-origin token now gets.
        if (controller.signal.aborted || videoIdFromUrl(location.href) !== id)
          throw new Error('视频已切换或读取已取消');
      }
      // The player's own request carries that token. Asking it beats scraping the transcript
      // panel, which a background tab may never render.
      const played = await captionsViaPlayer(
        document.querySelector<YouTubePlayer>('#movie_player'),
        capture,
        id,
        track,
        controller.signal,
      );
      if (played && videoIdFromUrl(location.href) === id) return played;
    }
    return await readNativeTranscript(id, trackId, controller.signal);
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error('字幕读取已超时或视频已切换，请重试或导入字幕文件。');
    throw error;
  } finally {
    clearTimeout(timeout);
    activeFetches.delete(controller);
  }
}

async function run(request: PageRequest): Promise<unknown> {
  if (request.type === 'video:get') return getVideo();
  if (request.type === 'transcript:get') return getTranscript(request.trackId);
  if (isAdPlaying()) {
    throw new Error('当前正在播放 YouTube 广告，暂时无法操作正片；广告结束后请重试。');
  }
  const video = document.querySelector<HTMLVideoElement>(
    '#movie_player video, video.html5-main-video',
  );
  if (!video) throw new Error('视频播放器尚未就绪，请等待视频加载。');
  const command = request.command;
  if (command.action === 'seek') {
    video.currentTime = Math.min(
      command.time,
      Number.isFinite(video.duration) ? video.duration : command.time,
    );
  } else if (command.action === 'speed') {
    video.playbackRate = command.speed;
  } else if (command.action === 'pause') {
    video.pause();
  } else if (video.paused) {
    await video.play();
  } else {
    video.pause();
  }
  return null;
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const result = parsePageRequest(event.data);
  if (!result.success) return;
  const { id, request } = result.data;
  void run(request).then(
    (data) => send({ ok: true, data }),
    (error: unknown) =>
      send({ ok: false, error: error instanceof Error ? error.message : '播放器操作失败。' }),
  );
  function send(reply: Reply<unknown>) {
    window.postMessage({ channel: RESPONSE_CHANNEL, id, reply }, location.origin);
  }
});

document.addEventListener('yt-navigate-start', () => {
  for (const controller of activeFetches) controller.abort();
});
window.addEventListener('pagehide', (event) => {
  if (event.persisted) return;
  for (const controller of activeFetches) controller.abort();
  capture.dispose();
});
