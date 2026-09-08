import type { VideoChapter } from '../shared/types';

const MAX_CHAPTERS = 500;
const MAX_TIME = 7 * 24 * 60 * 60;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  const data = record(value);
  if (typeof data.simpleText === 'string') return data.simpleText;
  return Array.isArray(data.runs)
    ? data.runs
        .slice(0, 100)
        .map((run) => {
          const value = record(run).text;
          return typeof value === 'string' ? value : '';
        })
        .join('')
    : '';
}

function normalize(chapters: VideoChapter[], duration: number): VideoChapter[] {
  const unique = new Map<number, VideoChapter>();
  for (const chapter of chapters) {
    const title = chapter.title.replace(/\s+/gu, ' ').trim().slice(0, 500);
    if (
      !title ||
      !Number.isFinite(chapter.start) ||
      chapter.start < 0 ||
      chapter.start > MAX_TIME ||
      (duration > 0 && chapter.start >= duration)
    )
      continue;
    if (!unique.has(chapter.start)) unique.set(chapter.start, { title, start: chapter.start });
  }
  return [...unique.values()].sort((a, b) => a.start - b.start).slice(0, MAX_CHAPTERS);
}

/** Only line-leading timestamps in this video's own description become navigation entries. */
export function chaptersFromDescription(description: string, duration = 0): VideoChapter[] {
  const chapters: VideoChapter[] = [];
  for (const line of description.slice(0, 100_000).split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:[-*•]\s*)?\[?(\d{1,3}:\d{2}(?::\d{2})?)\]?(?=\s|[-–—|:])\s*(?:[-–—|:]\s*)?(.+?)\s*$/u,
    );
    if (!match) continue;
    const parts = match[1]!.split(':').map(Number);
    if (parts.slice(1).some((part) => part >= 60)) continue;
    chapters.push({ start: parts.reduce((sum, part) => sum * 60 + part, 0), title: match[2]! });
    if (chapters.length >= MAX_CHAPTERS) break;
  }
  const result = normalize(chapters, duration);
  // A single timestamp often quotes a moment rather than defining a chapter list.
  return result.length >= 2 ? result : [];
}

/** Initial data is SPA-cached; only inspect player overlays belonging to the current video. */
export function extractVideoChapters(
  initialData: unknown,
  videoId: string,
  duration = 0,
): VideoChapter[] {
  const data = record(initialData);
  const endpointId = record(record(data.currentVideoEndpoint).watchEndpoint).videoId;
  const chapters: VideoChapter[] = [];
  if (endpointId === videoId) {
    const visited = new Set<object>();
    const queue: unknown[] = [data.playerOverlays];
    for (let index = 0; index < queue.length && index < 10_000; index++) {
      const value = queue[index];
      if (!value || typeof value !== 'object' || visited.has(value)) continue;
      visited.add(value);
      const object = record(value);
      if (object.chapterRenderer) {
        const chapter = record(object.chapterRenderer);
        const millis = chapter.timeRangeStartMillis;
        if (typeof millis === 'number' || (typeof millis === 'string' && /^\d+$/.test(millis)))
          chapters.push({ title: text(chapter.title), start: Number(millis) / 1000 });
      }
      if (chapters.length >= MAX_CHAPTERS) break;
      const children = Array.isArray(value) ? value : Object.values(object);
      queue.push(...children.slice(0, Math.max(0, 10_000 - queue.length)));
    }
  }
  return normalize(chapters, duration);
}
