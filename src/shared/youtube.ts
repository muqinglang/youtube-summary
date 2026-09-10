/**
 * YouTube video ids are 11 characters today, but the length has changed before and a stricter
 * pattern would silently drop working links. Wide enough to survive that, narrow enough that
 * nothing which is not an id can get through.
 */
const VIDEO_ID = /^[\w-]{6,20}$/;

/**
 * Builds a watch link from an id we validated ourselves.
 *
 * Cross-video results carry a URL the server stored on behalf of whichever client uploaded the
 * video's metadata, so that URL is untrusted input: rendering it as an href would let another
 * account choose where this one navigates. The id is the only part worth trusting, and only
 * after it matches.
 */
export function watchUrl(videoId: string, start = 0): string | undefined {
  if (!VIDEO_ID.test(videoId)) return undefined;
  const seconds = Number.isFinite(start) ? Math.max(0, Math.floor(start)) : 0;
  return `https://www.youtube.com/watch?v=${videoId}&t=${seconds}s`;
}
