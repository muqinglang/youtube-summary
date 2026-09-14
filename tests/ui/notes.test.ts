import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimLocalCopy,
  clearClips,
  pushClips,
  readClips,
  syncClips,
  uploadLegacyClips,
  writeClips,
  type Cloud,
} from '../../src/ui/notes';
import type { Clip } from '../../src/shared/types';

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: crypto.randomUUID(),
    start: 12,
    text: 'Check evidence before deciding.',
    translation: '在做出决定之前检查证据。',
    comment: '',
    createdAt: '2026-09-09T00:00:00.000Z',
    ...overrides,
  };
}

/** The server's rule in miniature: a copy no newer than the stored one is refused. */
function account() {
  const items = new Map<string, { value: unknown; updatedAt: number }>();
  const cloud = {
    get: vi.fn(async (name: string) => items.get(name) ?? null),
    put: vi.fn(async (name: string, value: unknown, updatedAt: number) => {
      const current = items.get(name);
      if (current && current.updatedAt >= updatedAt) return false;
      items.set(name, { value: structuredClone(value), updatedAt });
      return true;
    }),
  };
  return { items, cloud };
}

let data: Record<string, unknown>;
let now = 0;
beforeEach(() => {
  data = {};
  now = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) =>
          Object.fromEntries(
            [keys]
              .flat()
              .filter((name) => name in data)
              .map((name) => [name, structuredClone(data[name])]),
          ),
        ),
        getKeys: vi.fn(async () => Object.keys(data)),
        set: vi.fn(async (values: Record<string, unknown>) => {
          // A real storage area keeps a copy, so later changes to the object cannot leak in.
          Object.assign(data, structuredClone(values));
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          for (const name of [keys].flat()) delete data[name];
        }),
      },
    },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('clip storage', () => {
  it('keeps clips per video under their own key', async () => {
    await writeClips('videoA', [clip({ comment: '记一笔' })]);
    await writeClips('videoB', [clip({ start: 90 })]);
    expect((await readClips('videoA'))[0]?.comment).toBe('记一笔');
    expect((await readClips('videoB'))[0]?.start).toBe(90);
    // Its own prefix, so trimming the AI cache cannot reach it.
    expect(Object.keys(data)).toEqual(['notes:videoA', 'notes:videoB']);
  });

  it('reads notes saved before accounts, and returns nothing for an unknown or malformed entry', async () => {
    data['notes:legacy'] = [clip({ comment: '旧格式' })];
    expect((await readClips('legacy'))[0]?.comment).toBe('旧格式');
    expect(await readClips('missing')).toEqual([]);
    expect(await readClips('')).toEqual([]);
    data['notes:broken'] = { not: 'an array' };
    expect(await readClips('broken')).toEqual([]);
  });

  it('caps the number of clips rather than growing without limit', async () => {
    await writeClips(
      'videoA',
      Array.from({ length: 600 }, (_, index) => clip({ start: index })),
    );
    expect(await readClips('videoA')).toHaveLength(500);
  });

  it('refuses a write that would exceed the budget, keeping what is stored', async () => {
    await writeClips('videoA', [clip({ comment: '原有笔记' })]);
    const huge = Array.from({ length: 40 }, () => clip({ comment: 'x'.repeat(100_000) }));
    await expect(writeClips('videoA', huge)).rejects.toThrow('存储上限');
    // The failed write must not have destroyed the notes already saved.
    expect((await readClips('videoA'))[0]?.comment).toBe('原有笔记');
  });

  it('clears one video without touching another', async () => {
    await writeClips('videoA', [clip()]);
    await writeClips('videoB', [clip()]);
    await clearClips('videoA');
    expect(await readClips('videoA')).toEqual([]);
    expect(await readClips('videoB')).toHaveLength(1);
  });
});

describe('notes follow the account', () => {
  it('takes whichever copy changed last', async () => {
    const { items, cloud } = account();
    now = 100;
    await writeClips('videoA', [clip({ comment: '这台电脑' })]);
    items.set('notes:videoA', { value: [clip({ comment: '另一台电脑' })], updatedAt: 200 });
    expect((await syncClips('videoA', cloud))[0]?.comment).toBe('另一台电脑');

    now = 300;
    await writeClips('videoA', [clip({ comment: '改过了' })]);
    await syncClips('videoA', cloud);
    expect(items.get('notes:videoA')).toMatchObject({ updatedAt: 300, value: [{ comment: '改过了' }] });
  });

  it('carries a clear made on another machine instead of bringing the notes back', async () => {
    const { items, cloud } = account();
    now = 100;
    await writeClips('videoA', [clip()]);
    items.set('notes:videoA', { value: [], updatedAt: 200 });
    expect(await syncClips('videoA', cloud)).toEqual([]);
  });

  it('combines notes from before accounts with the account copy rather than dropping either', async () => {
    const { items, cloud } = account();
    const mine = clip({ start: 30, comment: '本机旧笔记' });
    const theirs = clip({ start: 10, comment: '账号里的' });
    data['notes:videoA'] = [mine];
    items.set('notes:videoA', { value: [theirs], updatedAt: 50 });
    now = 1000;
    const merged = await syncClips('videoA', cloud);
    expect(merged.map((item) => item.comment)).toEqual(['账号里的', '本机旧笔记']);
    expect(items.get('notes:videoA')).toEqual({ value: merged, updatedAt: 1000 });
    // Converted, so the next sync compares times instead of merging again.
    expect(data['notes:videoA']).toEqual({ clips: merged, updatedAt: 1000 });
  });

  it('uploads notes from before accounts once, and leaves everything else to its own sync', async () => {
    const { items, cloud } = account();
    data['notes:videoA'] = [clip()];
    data['notes:videoB'] = [clip()];
    data['learning:digest'] = { createdAt: 1, value: {} };
    now = 100;
    await writeClips('videoC', [clip()]);
    await uploadLegacyClips(cloud);
    expect([...items.keys()].sort()).toEqual(['notes:videoA', 'notes:videoB']);
    cloud.put.mockClear();
    await uploadLegacyClips(cloud);
    expect(cloud.put).not.toHaveBeenCalled();
  });

  it('keeps an edit made while the account copy was on its way', async () => {
    const { items, cloud } = account();
    now = 100;
    await writeClips('videoA', [clip({ comment: '旧的' })]);
    items.set('notes:videoA', { value: [clip({ comment: '账号里的' })], updatedAt: 200 });
    cloud.get.mockImplementationOnce(async (name: string) => {
      now = 300;
      await writeClips('videoA', [clip({ comment: '刚改的' })]);
      return items.get(name) ?? null;
    });
    expect((await syncClips('videoA', cloud))[0]?.comment).toBe('刚改的');
    await pushClips('videoA', cloud);
    expect(items.get('notes:videoA')).toMatchObject({ updatedAt: 300, value: [{ comment: '刚改的' }] });
  });

  it('ignores anything in the account copy that is not a note', async () => {
    const { items, cloud } = account();
    items.set('notes:videoA', { value: [clip({ comment: '好的' }), { id: 1 }, null], updatedAt: 200 });
    expect((await syncClips('videoA', cloud)).map((item) => item.comment)).toEqual(['好的']);

    items.set('notes:videoB', { value: '<img src=x onerror=alert(1)>', updatedAt: 999 });
    now = 100;
    await writeClips('videoB', [clip({ comment: '本机的' })]);
    expect((await syncClips('videoB', cloud))[0]?.comment).toBe('本机的');
  });

  it('leaves the notes on this machine alone when the account cannot be reached', async () => {
    const offline: Cloud = {
      get: async () => Promise.reject(new Error('offline')),
      put: async () => Promise.reject(new Error('offline')),
    };
    await writeClips('videoA', [clip({ comment: '离线写的' })]);
    await expect(syncClips('videoA', offline)).rejects.toThrow('offline');
    await expect(pushClips('videoA', offline)).rejects.toThrow('offline');
    expect((await readClips('videoA'))[0]?.comment).toBe('离线写的');
  });

  it('drops another account’s copy on sign-in, but lets the first account keep older notes', async () => {
    data['notes:videoA'] = [clip()];
    data['learning:digest'] = { createdAt: 1, value: {} };
    await claimLocalCopy('first');
    expect(Object.keys(data).sort()).toEqual([
      'learning:digest',
      'notes:videoA',
      'sidenote:dataOwner',
    ]);
    await claimLocalCopy('first');
    expect(data['notes:videoA']).toBeDefined();

    await claimLocalCopy('second');
    expect(data).toEqual({ 'sidenote:dataOwner': 'second' });
  });
});
