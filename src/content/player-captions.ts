import type { CapturedCaption, CaptionCapture, CaptureTrack } from './caption-capture';

/** The slice of YouTube's in-page player that switches captions on and reports what is showing. */
export interface CaptionPlayer {
  loadModule?: (name: string) => void;
  unloadModule?: (name: string) => void;
  getOption?: (module: string, option: string) => unknown;
  setOption?: (module: string, option: string, value: unknown) => void;
}

const WAIT_MS = 4_000;
const POLL_MS = 150;

/**
 * Has the page's own player request a caption track, so the passive capture records it.
 *
 * A direct fetch of the track URL increasingly comes back as HTTP 200 with an empty body: YouTube
 * wants a proof-of-origin token that only its own player attaches. When the player asks for the
 * same track, the token rides along and the response is real. Capture already records every
 * caption response the player receives; this only makes one happen, which is why reading worked
 * for a viewer who had turned captions on and failed for one who had not.
 *
 * Whatever the viewer had on screen is put back afterwards, so reading a transcript never leaves
 * captions switched on, or switched to another language, behind their back. The player methods
 * are undocumented; a page without them gets undefined and the DOM fallback runs as before.
 */
export async function captionsViaPlayer(
  player: CaptionPlayer | null | undefined,
  capture: Pick<CaptionCapture, 'get'>,
  videoId: string,
  track: CaptureTrack,
  signal: AbortSignal,
  { waitMs = WAIT_MS, pollMs = POLL_MS } = {},
): Promise<CapturedCaption | undefined> {
  if (!player?.setOption || !player.loadModule) return undefined;
  let previous: unknown;
  try {
    previous = player.getOption?.('captions', 'track');
  } catch {
    // The module is not loaded yet, which means nothing was showing.
  }
  try {
    player.loadModule('captions');
    player.setOption('captions', 'track', {
      languageCode: track.language,
      ...(track.automatic ? { kind: 'asr' } : {}),
    });
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && !signal.aborted) {
      const caption = capture.get(videoId, track);
      if (caption) return caption;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return capture.get(videoId, track);
  } catch {
    return undefined;
  } finally {
    try {
      if (isShowingTrack(previous)) player.setOption('captions', 'track', previous);
      else player.unloadModule?.('captions');
    } catch {
      // Best effort: a player that refuses the restore is no worse off than before the read.
    }
  }
}

/** `getOption` answers `{}` when no track is on and a track object when one is. */
function isShowingTrack(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Object.keys(value).length > 0;
}
