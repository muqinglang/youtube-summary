import { describe, expect, it } from 'vitest';
import { chaptersFromDescription, extractVideoChapters } from '../../src/content/chapters';
import { parsePlayerResponse, videoInfoSchema } from '../../src/content/protocol';

const videoId = 'QLLuZbuTIRc';
function initial(chapters: unknown[], id = videoId) {
  return {
    currentVideoEndpoint: { watchEndpoint: { videoId: id } },
    playerOverlays: { playerOverlayRenderer: { markers: chapters } },
  };
}
function chapter(start: unknown, title: unknown) {
  return { chapterRenderer: { timeRangeStartMillis: start, title } };
}

describe('real chapter extraction', () => {
  it('reads native player chapter renderers in chronological order and removes duplicate times', () => {
    expect(
      extractVideoChapters(
        initial([
          chapter(169000, { runs: [{ text: 'What this ' }, { text: 'course covers' }] }),
          chapter('0', { simpleText: 'Intro' }),
          chapter(0, { simpleText: 'Duplicate' }),
          chapter(18086000, { simpleText: 'Closing' }),
        ]),
        videoId,
        18139,
      ),
    ).toEqual([
      { title: 'Intro', start: 0 },
      { title: 'What this course covers', start: 169 },
      { title: 'Closing', start: 18086 },
    ]);
  });
  it('rejects old initial data after SPA navigation and does not inspect recommendations', () => {
    const previous = initial([chapter(0, { simpleText: 'Previous' })], 'arj7oStGLkU');
    expect(extractVideoChapters(previous, videoId)).toEqual([]);
    expect(
      extractVideoChapters({ ...initial([]), contents: [chapter(0, 'Unrelated video')] }, videoId),
    ).toEqual([]);
  });
  it('uses current player descriptions when initial data is missing or stale', () => {
    const response = {
      videoDetails: {
        videoId,
        lengthSeconds: '18139',
        shortDescription: 'Chapters\n0:00 Intro\n1:54:09 Expected value\n5:01:26 Closing',
      },
    };
    expect(parsePlayerResponse(response, videoId)?.chapters).toEqual([
      { title: 'Intro', start: 0 },
      { title: 'Expected value', start: 6849 },
      { title: 'Closing', start: 18086 },
    ]);
    expect(parsePlayerResponse(response, 'arj7oStGLkU')).toBeNull();
  });
  it('keeps titles as plain text and supports simple chapter list punctuation', () => {
    expect(
      chaptersFromDescription('- [0:00] <b>Intro</b>\n1:20 — 核对证据\n2:30|采取行动'),
    ).toEqual([
      { title: '<b>Intro</b>', start: 0 },
      { title: '核对证据', start: 80 },
      { title: '采取行动', start: 150 },
    ]);
  });
  it('does not manufacture chapters from isolated timestamps or ordinary prose', () => {
    expect(chaptersFromDescription('Watch at 1:30 for a moment\n0:00 Intro')).toEqual([]);
    expect(chaptersFromDescription('0:001 invalid\n0:89 invalid\n1:03:99 invalid')).toEqual([]);
  });
  it('filters invalid, out-of-duration, non-finite and malformed native entries', () => {
    expect(
      extractVideoChapters(
        initial([
          chapter(-1, 'negative'),
          chapter(Infinity, 'infinite'),
          chapter(1000, { runs: [{ text: {} }] }),
          chapter(45000, 'at end'),
          chapter('bad', 'bad'),
          chapter(null, 'null'),
          chapter(20000, 'Valid'),
        ]),
        videoId,
        45,
      ),
    ).toEqual([{ title: 'Valid', start: 20 }]);
  });
  it('bounds traversal, cycles, titles and chapter count', () => {
    const data = initial(
      Array.from({ length: 1000 }, (_, index) => chapter(index * 1000, 'x'.repeat(700))),
    );
    Object.assign(data.playerOverlays, { cycle: data });
    const result = extractVideoChapters(data, videoId);
    expect(result).toHaveLength(500);
    expect(result[0]?.title).toHaveLength(500);
  });
  it('preserves optional chapters through the page schema and rejects invalid timestamps', () => {
    const video = {
      id: videoId,
      title: '',
      author: '',
      url: '',
      duration: 45,
      currentTime: 0,
      paused: true,
      tracks: [],
    };
    expect(
      videoInfoSchema.parse({ ...video, chapters: [{ title: 'Intro', start: 0 }] }).chapters,
    ).toHaveLength(1);
    expect(
      videoInfoSchema.safeParse({ ...video, chapters: [{ title: 'Bad', start: Infinity }] })
        .success,
    ).toBe(false);
    expect(videoInfoSchema.safeParse(video).success).toBe(true);
  });
});
