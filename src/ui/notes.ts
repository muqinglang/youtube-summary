import type { Clip } from '../shared/types';
import { clearCache } from './cache';

/**
 * Clips are the user's own writing, so they live under their own prefix and are never evicted.
 * The AI cache in cache.ts trims itself to stay under a budget; doing that to notes would delete
 * work nobody can regenerate.
 */
const PREFIX = 'notes:';
const MAX_CLIPS = 500;
/** The account takes nothing larger, so a list that fits here is one that can also be kept there. */
const MAX_BYTES = 1024 * 1024;
const OWNER_KEY = 'sidenote:dataOwner';

/**
 * A video's notes and when they last changed on this machine, which is what decides whether this
 * copy or the account's wins. Notes written before accounts existed are a bare array instead.
 */
interface Stored {
  clips: Clip[];
  updatedAt: number;
}

/** The signed-in account's copy of what this person keeps. */
export interface Cloud {
  get(key: string): Promise<{ value: unknown; updatedAt: number } | null>;
  /** False when the account already holds a newer copy. */
  put(key: string, value: unknown, updatedAt: number): Promise<boolean>;
}

function key(videoId: string): string {
  return `${PREFIX}${videoId}`;
}

async function readStored(videoId: string): Promise<Stored | Clip[] | undefined> {
  const stored: unknown = (await chrome.storage.local.get(key(videoId)))[key(videoId)];
  if (Array.isArray(stored)) return stored as Clip[];
  if (stored && typeof stored === 'object' && Array.isArray((stored as Stored).clips))
    return stored as Stored;
  return undefined;
}

export async function readClips(videoId: string): Promise<Clip[]> {
  if (!videoId) return [];
  const stored = await readStored(videoId);
  return Array.isArray(stored) ? stored : (stored?.clips ?? []);
}

export async function writeClips(videoId: string, clips: Clip[]): Promise<void> {
  if (!videoId) return;
  const trimmed = clips.slice(0, MAX_CLIPS);
  if (new TextEncoder().encode(JSON.stringify(trimmed)).length > MAX_BYTES)
    throw new Error('笔记已超出存储上限，请先导出并删除部分卡片。');
  const stored: Stored = { clips: trimmed, updatedAt: Date.now() };
  await chrome.storage.local.set({ [key(videoId)]: stored });
}

export async function clearClips(videoId: string): Promise<void> {
  await chrome.storage.local.remove(key(videoId));
}

/** The server is a trust boundary like any other: only well-formed notes reach the panel. */
function isClip(value: unknown): value is Clip {
  if (typeof value !== 'object' || value === null) return false;
  const clip = value as Record<string, unknown>;
  return (
    typeof clip.id === 'string' &&
    Number.isFinite(clip.start) &&
    typeof clip.text === 'string' &&
    typeof clip.translation === 'string' &&
    typeof clip.comment === 'string' &&
    typeof clip.createdAt === 'string'
  );
}

/**
 * Brings one video's notes in line with the account's copy and returns what this machine now
 * holds. Whichever side changed last wins. Notes from before accounts have no time to compare, so
 * they are combined with the account's copy rather than replacing it or being replaced by it.
 */
export async function syncClips(videoId: string, cloud: Cloud): Promise<Clip[]> {
  const name = key(videoId);
  const local = await readStored(videoId);
  const found = await cloud.get(name);
  // Anything malformed counts as absent, so it can never replace real notes.
  const remote =
    found && Array.isArray(found.value)
      ? { clips: found.value.filter(isClip), updatedAt: found.updatedAt }
      : undefined;
  if (Array.isArray(local)) {
    const known = new Set(remote?.clips.map((clip) => clip.id));
    const merged: Stored = {
      clips: [...(remote?.clips ?? []), ...local.filter((clip) => !known.has(clip.id))].sort(
        (a, b) => a.start - b.start,
      ),
      updatedAt: Date.now(),
    };
    if (await cloud.put(name, merged.clips, merged.updatedAt)) await replace(videoId, local, merged);
  } else if (remote && (!local || remote.updatedAt > local.updatedAt)) {
    await replace(videoId, local, remote);
  } else if (local && (!remote || local.updatedAt > remote.updatedAt)) {
    await cloud.put(name, local.clips, local.updatedAt);
  }
  return readClips(videoId);
}

/** Writes what sync settled on, unless the notes were edited while it waited on the server. */
async function replace(videoId: string, seen: Stored | Clip[] | undefined, next: Stored) {
  if (JSON.stringify(await readStored(videoId)) === JSON.stringify(seen))
    await chrome.storage.local.set({ [key(videoId)]: next });
}

/** Sends a video's notes up after an edit. If it fails, the next sync finds them newer here. */
export async function pushClips(videoId: string, cloud: Cloud): Promise<void> {
  const local = await readStored(videoId);
  if (local && !Array.isArray(local)) await cloud.put(key(videoId), local.clips, local.updatedAt);
}

/** Notes kept before accounts existed, sent up so that another machine finds them too. */
export async function uploadLegacyClips(cloud: Cloud): Promise<void> {
  const names = (await chrome.storage.local.getKeys()).filter((name) => name.startsWith(PREFIX));
  const stored = await chrome.storage.local.get(names);
  for (const name of names)
    if (Array.isArray(stored[name])) await syncClips(name.slice(PREFIX.length), cloud);
}

/**
 * Notes and results on this machine are a copy of one account's. Signing in as someone else must
 * neither show them that copy nor upload it into their account, so it is dropped; the account it
 * belongs to still has it. No owner at all means notes from before accounts, which the first
 * account to sign in keeps.
 */
export async function claimLocalCopy(userId: string): Promise<void> {
  const owner: unknown = (await chrome.storage.local.get(OWNER_KEY))[OWNER_KEY];
  if (owner === userId) return;
  if (owner !== undefined) {
    // ponytail: edits the previous account never managed to upload go too; keep a copy per
    // account if switching accounts on one machine turns out to be common.
    const names = await chrome.storage.local.getKeys();
    await Promise.all([
      chrome.storage.local.remove(names.filter((name) => name.startsWith(PREFIX))),
      clearCache(),
    ]);
  }
  await chrome.storage.local.set({ [OWNER_KEY]: userId });
}
