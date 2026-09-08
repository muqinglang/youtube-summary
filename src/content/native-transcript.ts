import { parsePlayerResponse, videoIdFromUrl } from './protocol';

export interface NativeSegment {
  timestamp: string;
  text: string;
}

export interface NativeTranscriptResult {
  videoId: string;
  language: string;
  raw: string;
  coverage: 'unknown';
}

const PANEL_SELECTOR = 'ytd-engagement-panel-section-list-renderer';
const SEGMENT_SELECTOR = 'transcript-segment-view-model, ytd-transcript-segment-renderer';

/** Native panels expose display timestamps; never infer timestamps from translated text. */
export function nativeTimestamp(value: string): number | null {
  const normalized = value
    .normalize('NFKC')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim();
  if (
    !/^\d{1,5}:[0-5]\d(?:[.,]\d{1,3})?$|^\d{1,3}:[0-5]\d:[0-5]\d(?:[.,]\d{1,3})?$/.test(normalized)
  )
    return null;
  const seconds = normalized
    .replace(',', '.')
    .split(':')
    .reduce((sum, component) => sum * 60 + Number(component), 0);
  return Number.isFinite(seconds) && seconds <= 604_800 ? seconds : null;
}

/** DOM transcripts lack precise end times, so the caller always declares unknown coverage. */
export function nativeSegmentsToJson3(segments: NativeSegment[], duration?: number): string {
  if (!segments.length || segments.length > 100_000)
    throw new Error('原生转录没有可读取的段落，或段落数量过多。');
  const seen = new Set<string>();
  let textLength = 0;
  const cues = segments
    .flatMap((segment) => {
      const start = nativeTimestamp(segment.timestamp);
      const text = segment.text.replace(/\s+/gu, ' ').trim();
      if (start === null || !text)
        throw new Error('原生转录的时间戳或正文格式暂不支持，请导入 SRT / VTT 字幕。');
      if (text.length > 10_000 || (textLength += text.length) > 2_000_000)
        throw new Error('原生转录内容过大，请导入较小的字幕文件。');
      const identity = `${start}\0${text}`;
      if (seen.has(identity)) return [];
      seen.add(identity);
      return [{ start, text }];
    })
    .sort((left, right) => left.start - right.start);
  return JSON.stringify({
    events: cues.map((cue, index) => {
      const nextStart = cues[index + 1]?.start;
      const remaining =
        duration !== undefined && Number.isFinite(duration) && duration > cue.start
          ? duration - cue.start
          : 5;
      return {
        tStartMs: Math.round(cue.start * 1000),
        dDurationMs: Math.max(
          1,
          Math.round(
            Math.min(nextStart === undefined ? remaining : nextStart - cue.start, 30) * 1000,
          ),
        ),
        segs: [{ utf8: cue.text }],
      };
    }),
  });
}

function assertCurrent(videoId: string, signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('原生转录读取已取消。', 'AbortError');
  if (videoIdFromUrl(location.href) !== videoId)
    throw new Error('视频已切换，请重新读取当前视频字幕。');
}

function visible(element: Element): boolean {
  return element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
}

function transcriptRows(): Element[] {
  const panels = [...document.querySelectorAll(PANEL_SELECTOR)].filter(
    (panel) => panel.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED',
  );
  for (const panel of panels) {
    const rows = [...panel.querySelectorAll(SEGMENT_SELECTOR)];
    if (rows.length) return rows;
  }
  return [];
}

function nativeButton(): HTMLButtonElement | undefined {
  return [
    ...document.querySelectorAll<HTMLButtonElement>(
      'ytd-watch-metadata ytd-video-description-transcript-section-renderer button',
    ),
  ].find(
    (button) =>
      visible(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true',
  );
}

function waitFor<T>(
  probe: () => T | undefined,
  videoId: string,
  signal?: AbortSignal,
  timeoutMs = 15_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearInterval(interval);
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException('原生转录读取已取消。', 'AbortError'));
    };
    const check = () => {
      try {
        assertCurrent(videoId, signal);
        const result = probe();
        if (result !== undefined) {
          cleanup();
          resolve(result);
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const interval = setInterval(check, 100);
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error('YouTube 原生转录暂时未加载，请在视频下方打开「显示转录」后重试，或导入字幕。'),
      );
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    check();
  });
}

/** Reads YouTube's ordinary transcript panel, without replaying private API commands or tokens. */
export async function readNativeTranscript(
  videoId: string,
  trackId?: string,
  signal?: AbortSignal,
): Promise<NativeTranscriptResult> {
  assertCurrent(videoId, signal);
  const player = document.querySelector<HTMLElement & { getPlayerResponse?: () => unknown }>(
    '#movie_player',
  );
  const initial = (window as Window & { ytInitialPlayerResponse?: unknown })
    .ytInitialPlayerResponse;
  let response: unknown;
  try {
    response = player?.getPlayerResponse?.();
  } catch {
    /* Player may still be initializing. */
  }
  const metadata = parsePlayerResponse(response, videoId) || parsePlayerResponse(initial, videoId);
  if (!metadata) throw new Error('当前视频信息尚未就绪，请稍后重新读取字幕。');
  const requested = metadata.tracks.find((track) => track.id === trackId);
  if (trackId && (!requested || metadata.tracks.length !== 1)) {
    throw new Error(
      '无法确认原生转录与所选字幕轨一致，请选择「自动选择字幕」后重试，或导入指定语言字幕。',
    );
  }
  const language = metadata.tracks.length === 1 ? metadata.tracks[0]!.language : 'auto';
  if (!transcriptRows().length) {
    let button = nativeButton();
    if (!button) {
      let lastExpandClick = 0;
      button = await waitFor(
        () => {
          const ready = nativeButton();
          if (ready) return ready;
          const expand = [
            ...document.querySelectorAll<HTMLElement>('ytd-watch-metadata #expand'),
          ].find(visible);
          // YouTube can render the expander before attaching its click listener.
          if (expand && Date.now() - lastExpandClick >= 1_000) {
            lastExpandClick = Date.now();
            expand.click();
          }
          return undefined;
        },
        videoId,
        signal,
        8_000,
      );
    }
    assertCurrent(videoId, signal);
    button.click();
  }
  let fingerprint = '';
  let stableSince = 0;
  const rows = await waitFor(
    () => {
      const current = transcriptRows();
      if (!current.length) return;
      const identity = `${current.length}:${current[0]?.textContent}:${current.at(-1)?.textContent}`;
      if (identity !== fingerprint) {
        fingerprint = identity;
        stableSince = Date.now();
      }
      return Date.now() - stableSince >= 400 ? current : undefined;
    },
    videoId,
    signal,
  );
  const segments = rows.map((row) => {
    const modern = row.tagName.toLowerCase() === 'transcript-segment-view-model';
    return {
      timestamp:
        row.querySelector(modern ? '.ytwTranscriptSegmentViewModelTimestamp' : '.segment-timestamp')
          ?.textContent || '',
      text: row.querySelector(modern ? 'span[role="text"]' : '.segment-text')?.textContent || '',
    };
  });
  assertCurrent(videoId, signal);
  return {
    videoId,
    language,
    coverage: 'unknown',
    raw: nativeSegmentsToJson3(segments, metadata.duration),
  };
}
