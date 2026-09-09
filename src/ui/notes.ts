import type { Clip } from '../shared/types';

/**
 * Clips are the user's own writing, so they live under their own prefix and are never evicted.
 * The AI cache in cache.ts trims itself to stay under a budget; doing that to notes would delete
 * work nobody can regenerate.
 */
const PREFIX = 'notes:';
const MAX_CLIPS = 500;
const MAX_BYTES = 2 * 1024 * 1024;

function key(videoId: string): string {
  return `${PREFIX}${videoId}`;
}

export async function readClips(videoId: string): Promise<Clip[]> {
  if (!videoId) return [];
  const stored = (await chrome.storage.local.get(key(videoId)))[key(videoId)];
  return Array.isArray(stored) ? (stored as Clip[]) : [];
}

export async function writeClips(videoId: string, clips: Clip[]): Promise<void> {
  if (!videoId) return;
  const trimmed = clips.slice(0, MAX_CLIPS);
  if (new TextEncoder().encode(JSON.stringify(trimmed)).length > MAX_BYTES)
    throw new Error('笔记已超出本机存储上限，请先导出并删除部分卡片。');
  await chrome.storage.local.set({ [key(videoId)]: trimmed });
}

export async function clearClips(videoId: string): Promise<void> {
  await chrome.storage.local.remove(key(videoId));
}
