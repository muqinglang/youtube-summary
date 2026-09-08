const PREFIX = 'learning:';
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 20;
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;

interface CacheEntry<T> {
  createdAt: number;
  value: T;
}

export async function cacheKey(input: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return (
    PREFIX + [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  );
}

export async function readCache<T>(key: string): Promise<T | undefined> {
  const data = (await chrome.storage.local.get(key))[key] as CacheEntry<T> | undefined;
  if (data && Date.now() - data.createdAt < MAX_AGE) return data.value;
  return undefined;
}

export async function writeCache<T>(key: string, value: T): Promise<void> {
  const entry: CacheEntry<T> = { createdAt: Date.now(), value };
  if (new TextEncoder().encode(JSON.stringify(entry)).length > MAX_BYTES / 2) return;
  // Keep independent keys to avoid whole-cache lost updates when two videos finish together.
  await chrome.storage.local.set({ [key]: entry });
  const keys = (await chrome.storage.local.getKeys()).filter((name) => name.startsWith(PREFIX));
  const all = await chrome.storage.local.get(keys);
  const entries = Object.entries(all)
    .filter(([name]) => name.startsWith(PREFIX))
    .map(([name, item]) => ({ name, entry: item as CacheEntry<unknown> }))
    .sort((a, b) => b.entry.createdAt - a.entry.createdAt);
  let size = 0;
  const stale = entries.filter(({ entry }, index) => {
    size += new TextEncoder().encode(JSON.stringify(entry)).length;
    return index >= MAX_ENTRIES || size > MAX_BYTES || Date.now() - entry.createdAt > MAX_AGE;
  });
  if (stale.length) await chrome.storage.local.remove(stale.map(({ name }) => name));
}

export async function clearCache(): Promise<void> {
  const keys = await chrome.storage.local.getKeys();
  await chrome.storage.local.remove(keys.filter((key) => key.startsWith(PREFIX)));
}
