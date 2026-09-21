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
/** The cue the panel last asked to show, and when it is spoken. */
let caption: { start: number; end: number; original: string; translated: string } | undefined;
/** That cue cut into pieces that fit each row, at the width they were measured at. */
let captionPieces = { width: -1, original: [''], translated: [''] };
const words = new Intl.Segmenter(undefined, { granularity: 'word' });

/** What the CC menu offers. Picked from a list rather than cycled: four states is too many to step through. */
const CAPTION_MODES = [
  { value: 'bilingual', label: '双语' },
  { value: 'original', label: '仅原文' },
  { value: 'translated', label: '仅译文' },
  { value: 'off', label: '不显示' },
] as const;
const SPEEDS = [0.25, 0.75, 1, 1.25, 1.5, 2] as const;

/** Both menus behave the same way, so they are built and closed the same way. */
function buildMenu(
  container: string,
  items: readonly { value: string; label: string }[],
  onPick: (value: string) => void,
) {
  const host = $(container);
  host.replaceChildren(
    ...items.map((item) => {
      const button = document.createElement('button');
      button.className = 'player-menu-option';
      button.dataset.value = item.value;
      button.textContent = item.label;
      button.addEventListener('click', () => {
        onPick(item.value);
        closeMenus();
      });
      return button;
    }),
  );
}

function markMenu(container: string, value: string) {
  for (const option of $(container).querySelectorAll<HTMLElement>('.player-menu-option'))
    option.classList.toggle('is-current', option.dataset.value === value);
}

function closeMenus(except?: string) {
  for (const [menu, toggle] of [
    ['#speed-menu', '#speed-toggle'],
    ['#volume-menu', '#volume-toggle'],
    ['#captions-menu', '#captions-toggle'],
  ]) {
    if (menu === except) continue;
    $(menu!).hidden = true;
    $(toggle!).setAttribute('aria-expanded', 'false');
  }
}

function toggleMenu(menu: string, toggle: string) {
  const open = $(menu).hidden;
  closeMenus(open ? menu : undefined);
  $(menu).hidden = !open;
  $(toggle).setAttribute('aria-expanded', String(open));
}

function applyPreferences(next: LearningPreferences) {
  const previous = preferences;
  preferences = next;
  $<HTMLButtonElement>('#settings').disabled = next.busy;
  $('#subtitles').hidden = !next.overlayEnabled;
  const showing = next.overlayEnabled ? next.displayMode : 'off';
  const label = CAPTION_MODES.find((mode) => mode.value === showing) ?? CAPTION_MODES[0];
  $('#captions-toggle').setAttribute('aria-pressed', String(next.overlayEnabled));
  $('#captions-toggle').title = `字幕：${label.label}`;
  markMenu('#captions-options', showing);
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
  paintCaption();
}
/** The played portion is drawn by the track gradient, so the fill ratio has to reach CSS. */
function paintTimeline() {
  const timeline = $<HTMLInputElement>('#timeline');
  const max = Number(timeline.max) || 1;
  const ratio = Math.min(1, Math.max(0, Number(timeline.value) / max));
  timeline.style.setProperty('--progress', String(ratio));
}

/**
 * Cuts text into pieces that each fit the row, breaking only before a word so punctuation stays
 * with what it follows. Measured against the row itself, so it holds for any script, font and width.
 */
function paginate(row: HTMLElement, text: string): string[] {
  // A hidden row has no box to measure against; it is cut again once it has one.
  if (!text || !row.clientHeight) return [text];
  const pieces: string[] = [];
  let piece = '';
  for (const { segment, isWordLike } of words.segment(text)) {
    row.textContent = piece + segment;
    if (isWordLike && piece.trim() && row.scrollHeight > row.clientHeight + 1) {
      pieces.push(piece.trim());
      piece = segment;
    } else piece += segment;
  }
  pieces.push(piece.trim());
  return pieces;
}

/** Weighted by length, so a short last piece is not held on screen as long as a full one. */
function pieceAt(pieces: string[], progress: number): string {
  const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
  let offset = Math.min(Math.max(progress, 0), 1) * total;
  for (const piece of pieces) {
    if (offset < piece.length) return piece;
    offset -= piece.length;
  }
  return pieces[pieces.length - 1] ?? '';
}

/**
 * The rows keep a fixed height so the player above never moves, which means a cue longer than its
 * row cannot simply wrap. It is shown a piece at a time instead, following how far into the cue
 * playback is: roughly where the speaker is in the sentence.
 */
function paintCaption() {
  if (!caption) return;
  const original = $('#original');
  const translated = $('#translated');
  const width = $('#subtitles').clientWidth;
  if (width !== captionPieces.width)
    captionPieces = {
      width,
      original: paginate(original, caption.original),
      translated: paginate(translated, caption.translated),
    };
  const span = caption.end - caption.start;
  const progress = span > 0 ? (video.currentTime - caption.start) / span : 0;
  const nextOriginal = pieceAt(captionPieces.original, progress);
  const nextTranslated = pieceAt(captionPieces.translated, progress);
  // Only on change: this runs on every playback update, and rewriting the same text still lays out.
  if (original.textContent !== nextOriginal) original.textContent = nextOriginal;
  if (translated.textContent !== nextTranslated) translated.textContent = nextTranslated;
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
      const transcript = await send<Transcript>({ ...request, tabId: sourceTabId, videoId });
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
    caption = {
      start: command.start,
      end: command.end,
      original: visible ? command.original : '',
      translated: visible ? command.translated : '',
    };
    captionPieces.width = -1;
    paintCaption();
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
/**
 * The word under the pointer, read from the text node itself so the caption stays plain text.
 * The same technique the subtitle list uses, and the same segmenter it is paginated with.
 */
function wordAtPoint(x: number, y: number): string {
  const caret = document.caretPositionFromPoint(x, y);
  const node = caret?.offsetNode;
  if (!caret || node?.nodeType !== Node.TEXT_NODE) return '';
  const part = words.segment(node.textContent ?? '').containing(caret.offset);
  return part?.isWordLike ? part.segment : '';
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
        caption = undefined;
        $('#original').textContent = '';
        $('#translated').textContent = '';
      }
      error(message);
    },
  );
  loadingMetadata = refreshMetadata();
  // Width decides where a long cue is cut, and it can change while paused, when no playback update
  // would come along to cut it again.
  new ResizeObserver(paintCaption).observe($('#subtitles'));
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
  buildMenu(
    '#speed-options',
    SPEEDS.map((rate) => ({ value: String(rate), label: `${rate}×` })),
    (value) => {
      player.speed(Number(value));
      $('#speed-now').textContent = `${value}×`;
      markMenu('#speed-options', value);
    },
  );
  markMenu('#speed-options', '1');
  buildMenu('#captions-options', CAPTION_MODES, (value) => panelAction('captions-mode', value));
  const volume = $<HTMLInputElement>('#volume');
  const paintVolume = () => {
    const level = Number(volume.value);
    volume.style.setProperty('--progress', String(level / 100));
    $('#volume-now').textContent = String(level);
    // A muted player still shows its own icon, so the waves say what this control did.
    $('#volume-waves').setAttribute('opacity', level ? '1' : '0.25');
  };
  on(
    '#volume',
    () => {
      paintVolume();
      player.volume(Number(volume.value));
    },
    'input',
  );
  // Only paints: the player is not ready while these are being bound, and asking it then would
  // throw and leave every binding after this one unregistered.
  paintVolume();
  on('#speed-toggle', () => toggleMenu('#speed-menu', '#speed-toggle'));
  on('#volume-toggle', () => toggleMenu('#volume-menu', '#volume-toggle'));
  on('#captions-toggle', () => toggleMenu('#captions-menu', '#captions-toggle'));
  document.addEventListener('pointerdown', (event) => {
    if (!(event.target as Element | null)?.closest('.menu-wrap')) closeMenus();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenus();
  });
  on('#settings', () => panelAction('settings'));
  on('#guide', () => panelAction('guide'));

  // A word here is as good a place to ask about as one in the list beside it.
  $('#original').addEventListener('click', (event) => {
    if (!(window.getSelection()?.isCollapsed ?? true)) return;
    const word = wordAtPoint(event.clientX, event.clientY);
    if (word) panelAction('lookup', word);
  });
  on('#explain-caption', () => panelAction('explain-line'));
  on('#focus-toggle', () => {
    const focused = document.body.classList.toggle('focus-mode');
    $('#focus-toggle').setAttribute('aria-pressed', String(focused));
    $('#focus-toggle').title = focused ? '恢复面板与字幕条' : '放大画面：暂时收起右侧面板与字幕条';
  });
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
