import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearClips, readClips, writeClips } from '../../src/ui/notes';
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

describe('clip storage', () => {
  let data: Record<string, unknown>;
  beforeEach(() => {
    data = {};
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: data[key] })),
          set: vi.fn(async (values: Record<string, unknown>) => {
            Object.assign(data, values);
          }),
          remove: vi.fn(async (key: string) => {
            delete data[key];
          }),
        },
      },
    });
  });

  it('keeps clips per video under their own key', async () => {
    await writeClips('videoA', [clip({ comment: '记一笔' })]);
    await writeClips('videoB', [clip({ start: 90 })]);
    expect((await readClips('videoA'))[0]?.comment).toBe('记一笔');
    expect((await readClips('videoB'))[0]?.start).toBe(90);
    // Its own prefix, so trimming the AI cache cannot reach it.
    expect(Object.keys(data)).toEqual(['notes:videoA', 'notes:videoB']);
  });

  it('returns an empty list for an unknown or malformed entry', async () => {
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

  it('refuses a write that would exceed the local budget, keeping what is stored', async () => {
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
