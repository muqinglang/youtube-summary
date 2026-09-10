import '../shared/zod-setup';
import { formatTime } from '../core/transcript';
import { videoInfoSchema } from '../content/protocol';
import type { LearningPreferences, RuntimeRequest, Transcript, VideoInfo } from '../shared/types';
import { element as $, errorMessage } from './dom';
import { send } from './runtime';
import { YoutubePlayer } from './youtube-player';

const params = new URLSearchParams(location.search);
const videoId = params.get('videoId') || '';
const sourceTabId = params.has('tabId') ? Number(params.get('tabId')) : NaN;
const start = Math.max(0, Math.min(604800, Number(params.get('start')) || 0));
const panel = $<HTMLIFrameElement>('#study-panel');
let video: VideoInfo;
let player: YoutubePlayer;
let loadingMetadata: Promise<void>;
let sourcePoll = 0;
let fetchingMetadata = false;
let savedTranscript: { trackId?: string; transcript: Transcript } | undefined;
let transcriptRequestId = 0;
let timelinePointerId: number | undefined;
let preferences: LearningPreferences | undefined;

function applyPreferences(next: LearningPreferences) {
  const previous = preferences;
  preferences = next;
  $<HTMLButtonElement>('#settings').disabled = next.busy;
  $('#subtitles').hidden = !next.overlayEnabled;
  $('#captions-toggle').setAttribute('aria-pressed', String(next.overlayEnabled));
  if (next.overlayEnabled && previous?.overlayEnabled === false)
    player.setExternalCaptions(true, true);
}

function error(message: string) {
  $('#player-error').textContent = message;
  $('#player-error').hidden = false;
}
function publishVideo() {
  if (!video) return;
  panel.contentWindow?.postMessage({ type: 'sidenote:learning-video', video }, location.origin);
  $('#clock').textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
  $<HTMLInputElement>('#timeline').max = String(Math.max(1, video.duration));
  if (timelinePointerId === undefined)
    $<HTMLInputElement>('#timeline').value = String(video.currentTime);
  paintTimeline();
  $('#play').textContent = video.paused ? '▶' : 'Ⅱ';
}
/** The played portion is drawn by the track gradient, so the fill ratio has to reach CSS. */
function paintTimeline() {
  const timeline = $<HTMLInputElement>('#timeline');
  const max = Number(timeline.max) || 1;
  const ratio = Math.min(1, Math.max(0, Number(timeline.value) / max));
  timeline.style.setProperty('--progress', String(ratio));
}

function mergeMetadata(next: VideoInfo) {
  if (next.id !== videoId) return;
  video = { ...next, currentTime: video?.currentTime ?? start, paused: video?.paused ?? true };
  document.title = `${video.title} · 旁听`;
  $('#lesson-title').textContent = video.title;
  $('#lesson-title').title = video.title;
  $('#lesson-author').textContent = video.author || 'YouTube';
  publishVideo();
}
async function refreshMetadata() {
  if (fetchingMetadata) return;
  fetchingMetadata = true;
  try {
    const next = await send<VideoInfo>({ type: 'video:get', tabId: sourceTabId });
    if (next.id === videoId) mergeMetadata(videoInfoSchema.parse(next));
  } catch {
    /* The original tab may be closed after its transcript has been read. */
  } finally {
    fetchingMetadata = false;
  }
}
async function request(request: RuntimeRequest): Promise<unknown> {
  await loadingMetadata;
  if (request.type === 'video:get') return video;
  if (request.type === 'transcript:get') {
    const requestId = ++transcriptRequestId;
    try {
      const transcript = await send<Transcript>({ ...request, tabId: sourceTabId });
      if (transcript.videoId !== videoId)
        throw new Error('原标签页已切换到其他视频，请返回当前视频后重新读取。');
      if (requestId === transcriptRequestId) {
        savedTranscript = { trackId: request.trackId, transcript };
        if (JSON.stringify(transcript).length < 1_500_000) {
          void chrome.storage.session
            .set({ [`learning-transcript:${videoId}`]: savedTranscript })
            .catch(() => {});
        }
      }
      return transcript;
    } catch (cause) {
      if (savedTranscript && savedTranscript.trackId === request.trackId) {
        return savedTranscript.transcript;
      }
      throw cause;
    }
  }
  if (request.type !== 'player:command') throw new Error('学习页面不支持此操作。');
  const command = request.command;
  if (command.action === 'seek') {
    player.seek(command.time);
    video.currentTime = Math.min(command.time, video.duration || command.time);
    publishVideo();
  } else if (command.action === 'togglePlay') player.toggle();
  else if (command.action === 'pause') player.pause();
  else if (command.action === 'speed') player.speed(command.speed);
  else if (command.action === 'overlay') {
    const visible = command.visible && player.matchesVideo;
    // The rows are reserved by mode, not by content: an empty row still holds its height, so a
    // pending translation or a gap between cues cannot resize the block under the player.
    const box = $('#subtitles');
    box.dataset.mode = command.mode;
    box.dataset.enabled = String(command.enabled && player.matchesVideo);
    $('#original').textContent = visible ? command.original : '';
    $('#translated').textContent = visible ? command.translated : '';
  } else if (command.action === 'close') window.close();
  return null;
}

function on(selector: string, handler: () => void | Promise<unknown>, event = 'click') {
  $(selector).addEventListener(event, () => {
    Promise.resolve()
      .then(handler)
      .catch((cause: unknown) => error(errorMessage(cause)));
  });
}
function panelAction(action: string, value?: string | boolean) {
  panel.contentWindow?.postMessage(
    { type: 'sidenote:learning-action', action, value },
    location.origin,
  );
}

async function initialize() {
  if (!/^[\w-]{11}$/.test(videoId) || !Number.isInteger(sourceTabId) || sourceTabId < 0)
    throw new Error('学习链接无效，请在 YouTube 视频页面点击「旁听 AI」重新打开。');
  $<HTMLAnchorElement>('#source-link').href = `https://www.youtube.com/watch?v=${videoId}`;
  video = {
    id: videoId,
    title: 'YouTube 视频',
    author: '',
    url: `https://www.youtube.com/watch?v=${videoId}`,
    duration: 0,
    currentTime: start,
    paused: true,
    tracks: [],
  };
  const stored = await chrome.storage.session.get([
    `learning-session:${videoId}`,
    `learning-transcript:${videoId}`,
  ]);
  const session = stored[`learning-session:${videoId}`] as { video?: unknown } | undefined;
  const metadata = videoInfoSchema.safeParse(session?.video);
  if (metadata.success && metadata.data.id === videoId) mergeMetadata(metadata.data);
  const previous = stored[`learning-transcript:${videoId}`] as typeof savedTranscript;
  if (previous?.transcript?.videoId === videoId && Array.isArray(previous.transcript.cues))
    savedTranscript = previous;
  (window as Window & { sidenoteLearning?: { request: typeof request } }).sidenoteLearning = {
    request,
  };
  player = new YoutubePlayer(
    $<HTMLIFrameElement>('#player'),
    videoId,
    start,
    (state) => {
      video = {
        ...video,
        currentTime: state.currentTime,
        duration: state.duration || video.duration,
        paused: state.paused,
      };
      $('#player-error').hidden = true;
      publishVideo();
    },
    (message) => {
      if (!player.matchesVideo) {
        $('#original').textContent = '';
        $('#translated').textContent = '';
      }
      error(message);
    },
  );
  loadingMetadata = refreshMetadata();
  panel.src = chrome.runtime.getURL(`panel.html?workspace=1&tabId=${sourceTabId}`);
  sourcePoll = window.setInterval(() => {
    void refreshMetadata();
  }, 5000);
  on('#play', () => player.toggle());
  $('#timeline').addEventListener('pointerdown', (event) => {
    timelinePointerId = event.pointerId;
  });
  $('#timeline').addEventListener('input', paintTimeline);
  const endTimelineDrag = (event: PointerEvent) => {
    if (event.pointerId === timelinePointerId) timelinePointerId = undefined;
  };
  window.addEventListener('pointerup', endTimelineDrag);
  window.addEventListener('pointercancel', endTimelineDrag);
  window.addEventListener('blur', () => {
    timelinePointerId = undefined;
  });
  on('#backward', () =>
    request({
      type: 'player:command',
      tabId: sourceTabId,
      command: { action: 'seek', time: Math.max(0, video.currentTime - 10) },
    }),
  );
  on('#forward', () =>
    request({
      type: 'player:command',
      tabId: sourceTabId,
      command: { action: 'seek', time: Math.min(video.duration, video.currentTime + 10) },
    }),
  );
  on(
    '#timeline',
    () =>
      request({
        type: 'player:command',
        tabId: sourceTabId,
        command: { action: 'seek', time: Number($<HTMLInputElement>('#timeline').value) },
      }),
    'change',
  );
  on('#speed', () => player.speed(Number($<HTMLSelectElement>('#speed').value)), 'change');
  on('#settings', () => panelAction('settings'));
  on('#guide', () => panelAction('guide'));
  on('#captions-toggle', () => panelAction('captions', !(preferences?.overlayEnabled ?? true)));
  on('#fullscreen', () =>
    document.fullscreenElement
      ? document.exitFullscreen()
      : document.documentElement.requestFullscreen(),
  );
  publishVideo();
}
window.addEventListener('message', (event) => {
  if (event.source !== panel.contentWindow || event.origin !== location.origin) return;
  if (event.data?.type === 'sidenote:learning-preferences')
    applyPreferences(event.data.preferences as LearningPreferences);
});
window.addEventListener('pagehide', () => {
  clearInterval(sourcePoll);
  player?.dispose();
});
void initialize().catch((cause: unknown) => {
  error(errorMessage(cause));
  $('#lesson-title').textContent = '学习页面暂时无法打开';
});
