import '../shared/zod-setup';
import {
  buildMarkdown,
  buildSrt,
  buildSubtitleMarkdown,
  buildXMind,
  subtitleLines,
} from '../core/exports';
import { findCueIndex, formatTime, parseTranscript } from '../core/transcript';
import { getOriginPattern } from '../shared/endpoint';
import { getProvider, PROVIDERS } from '../shared/providers';
import { SUBSCRIPTION_ENABLED } from '../shared/hosted';
import { watchUrl } from '../shared/youtube';
import type {
  AiRequest,
  AiProvider,
  AiResult,
  Answer,
  ChatTurn,
  Clip,
  Cue,
  ExportDocument,
  ExplainMode,
  Explanation,
  Glossary,
  GlossaryTerm,
  Guide,
  JobProgress,
  LearningPreferences,
  Outline,
  PlayerCommand,
  SectionKind,
  TermKind,
  PublicSettings,
  RunMode,
  RuntimeEvent,
  Summary,
  Transcript,
  WordSense,
  VideoChapter,
  VideoInfo,
  LibraryMatch,
  DisplayMode,
} from '../shared/types';
import { cacheKey, clearCache, readCache, writeCache } from './cache';
import {
  pushClips,
  readAllClips,
  readClips,
  syncClips,
  syncNoteIndex,
  uploadLegacyClips,
  writeClips,
  type Cloud,
  type VideoClips,
} from './notes';
import { downloadFile, element as $, errorMessage, escapeHtml as esc } from './dom';
import { runJob, send } from './runtime';
import { googleTranslateUrl, resolveTranslationEngine } from './google-translate';
import { lookupWord, translateCuesCloud, type WordEntry } from './cloud-translate';

const VIEWS = ['guide', 'transcript', 'chapters', 'glossary', 'notes', 'summary', 'chat'] as const;
type Tab = (typeof VIEWS)[number];
/**
 * Only these sit in the tab bar. Seven tabs overflowed at 360px, and the two that left are the
 * ones that hold what you produced rather than what the video is about, so they live in the
 * footer next to 导出笔记.
 */
const TABS = [
  'guide',
  'transcript',
  'chapters',
  'summary',
  'chat',
] as const satisfies readonly Tab[];

const params = new URLSearchParams(location.search);
const workspace = params.has('workspace') && window.parent !== window;
if (workspace) document.body.classList.add('workspace-panel');
const rawTabId = params.get('tabId');
const tabId = rawTabId === null ? -1 : Number(rawTabId);
const WINDOW_SIZE = 100;
/**
 * What each one asks for has to be something a reader can see in the result: a different focus, a
 * different shape, a different length. Rules the model already follows — stay in the video, keep
 * the timestamps honest — are in the system prompt, and repeating them here only costs words.
 */
const PRESETS = {
  learn:
    '面向第一次接触这个话题的人：把每章的观点讲透，遇到术语先解释再用，保留讲者给出的例子和数字。',
  quick: '用最少的字说清楚：三个核心观点，每个一句话，再加一句这段视频值不值得完整看。',
  action:
    '只要能上手做的事：每条写清做什么、第一步怎么开始、需要什么条件。视频没讲怎么做的，就不要写成行动。',
  claims:
    '把主张和依据分开写：每个观点后面列出讲者给的证据（数据、案例、亲身经历），只有说法没有依据的，标一句「未给出依据」。',
  facts: '抓硬信息：数字、时间、金额、公司和人名、提到的研究或产品，每一条都写清它说明的是什么。',
};

const state: {
  video?: VideoInfo;
  transcript?: Transcript;
  settings?: PublicSettings;
  translations: Record<string, string>;
  summary?: Summary;
  outline?: Outline;
  guide?: Guide;
  glossary?: Glossary;
  clips: Clip[];
  /** Whether the notes view shows this video's notes or everything kept on this machine. */
  notesScope: 'video' | 'all';
  summaryPrompt: string;
  tab: Tab;
  query: string;
  follow: boolean;
  activeCue: number;
  windowStart: number;
  displayMode: DisplayMode;
  loadVersion: number;
  loading: boolean;
  skipFiller: boolean;
  /** Whether the signed-in server offers cross-video retrieval at all. */
  librarySearch: boolean;
  askScope: 'video' | 'library';
  searching: boolean;
  job?: AbortController;
  jobTask?: AiRequest['task'];
} = {
  translations: {},
  notesScope: 'video',
  summaryPrompt: '',
  tab: 'transcript',
  query: '',
  follow: true,
  activeCue: -1,
  windowStart: 0,
  displayMode: 'bilingual',
  loadVersion: 0,
  loading: false,
  skipFiller: false,
  librarySearch: false,
  askScope: 'video',
  searching: false,
  clips: [],
};
let toastTimer = 0;
let commentSaveTimer = 0;
let lastOverlay = '';
let savingTranslationEngine = false;
const attemptedTrackSets = new Set<string>();
let lastPreferences = '';
let testingConnection = false;
let exportingSubtitles = false;
let connectionFormVersion = 0;
interface ChapterEntry extends VideoChapter {
  density?: number;
  kind?: SectionKind;
}
let chapters: ChapterEntry[] = [];
/** Sections at or below this are the ones 「只看干货」 skips. */
const FILLER_DENSITY = 2;
/** How long an explicit jump protects its destination from the filler skip. */
const SEEK_GRACE_MS = 2_000;
const KIND_LABELS: Record<SectionKind, string> = {
  concept: '概念',
  example: '案例',
  demo: '演示',
  filler: '闲聊',
  promo: '推广',
};
let chapterIdentity = '';
let activeChapter = -1;

function connectionFormChanged(): void {
  connectionFormVersion++;
  $('#settings-error').hidden = true;
  updateConnectionTest();
}

function publishPreferences(): void {
  if (!workspace) return;
  const preferences: LearningPreferences = {
    overlayEnabled: $<HTMLInputElement>('#overlay-enabled').checked,
    displayMode: state.displayMode,
    busy: Boolean(state.job),
  };
  const identity = JSON.stringify(preferences);
  if (lastPreferences === identity) return;
  lastPreferences = identity;
  window.parent.postMessage(
    { type: 'sidenote:learning-preferences', preferences },
    location.origin,
  );
}

/**
 * The 章节 tab prefers the book-style AI outline, then the AI summary's chapters, and otherwise
 * falls back to the video's own chapters so the tab is useful the moment it opens — generating
 * the AI outline stays one click away in the heading.
 */
const CHAPTER_LABELS = {
  outline: 'AI 内容目录',
  summary: 'AI 总结章节',
  native: '视频原生章节',
} as const;
function chapterSource(): {
  kind: keyof typeof CHAPTER_LABELS;
  entries: {
    title: string;
    start: number;
    points?: string[];
    density?: number;
    kind?: SectionKind;
  }[];
} {
  if (state.outline?.sections.length) return { kind: 'outline', entries: state.outline.sections };
  if (state.summary?.sections.length) return { kind: 'summary', entries: state.summary.sections };
  return { kind: 'native', entries: state.video?.chapters ?? [] };
}

let verdictIdentity = '';

/**
 * The share of the video worth watching is derived from the section densities rather than asked
 * for a second time, so the headline number cannot contradict the sections it summarises.
 */
function renderVerdict(): void {
  const verdict = state.outline?.verdict;
  const sections = state.outline?.sections ?? [];
  const duration = state.video?.duration ?? 0;
  const identity = JSON.stringify([verdict, sections.length, duration]);
  if (identity === verdictIdentity) return;
  verdictIdentity = identity;
  const card = $('#chapter-verdict');
  if (!verdict || !sections.length) {
    card.hidden = true;
    return;
  }
  let worthwhile = 0;
  let covered = 0;
  sections.forEach((section, index) => {
    const end = sections[index + 1]?.start ?? duration;
    const span = Math.max(0, end - section.start);
    covered += span;
    if (section.density > FILLER_DENSITY) worthwhile += span;
  });
  const rows: [string, string][] = [
    ['讲什么', verdict.topic],
    ['适合谁', verdict.audience],
    ['前置知识', verdict.prerequisites],
    ['怎么看', verdict.advice],
  ];
  const share = covered > 0 ? Math.round((worthwhile / covered) * 100) : 0;
  const body = document.createElement('div');
  body.className = 'verdict-body';
  if (covered > 0) {
    const density = document.createElement('p');
    density.className = 'verdict-density';
    density.textContent = `${formatTime(covered)} 中约 ${formatTime(worthwhile)} 为高密度内容（${share}%）`;
    body.append(density);
  }
  for (const [label, value] of rows) {
    // A model that leaves a field blank should not leave an empty row behind.
    if (!value.trim()) continue;
    const row = document.createElement('p');
    row.className = 'verdict-row';
    const name = document.createElement('span');
    name.textContent = label;
    row.append(name, document.createTextNode(value));
    body.append(row);
  }
  card.replaceChildren(body);
  card.hidden = false;
}

function renderChapters(): void {
  renderVerdict();
  const { kind, entries: source } = chapterSource();
  const sections = source
    .filter(({ start }) => !state.video?.duration || start < state.video.duration)
    .slice(0, 500)
    .map((entry) => ({
      title: entry.title,
      start: entry.start,
      points: (entry.points ?? []).slice(0, 6),
      density: entry.density,
      kind: entry.kind,
    }))
    .sort((a, b) => a.start - b.start);
  // The source kind is part of the identity: an AI outline replacing identical native chapters
  // still has to relabel the heading.
  const identity = JSON.stringify([state.video?.id, kind, sections]);
  if (identity !== chapterIdentity) {
    const container = $('#chapter-list');
    const focused = container.contains(document.activeElement)
      ? (document.activeElement as HTMLButtonElement)
      : undefined;
    chapters = sections.map(({ title, start, density, kind }) => ({
      title,
      start,
      density,
      kind,
    }));
    chapterIdentity = identity;
    activeChapter = -1;
    container.replaceChildren(
      ...sections.map((section, index) => {
        const button = document.createElement('button');
        button.className = 'chapter-card';
        button.dataset.chapter = String(index);
        button.dataset.seek = String(section.start);
        button.title = section.title;
        const number = document.createElement('span');
        number.className = 'chapter-number';
        number.textContent = String(index + 1).padStart(2, '0');
        const main = document.createElement('span');
        main.className = 'chapter-main';
        const title = document.createElement('span');
        title.className = 'chapter-title';
        title.textContent = section.title;
        main.append(title);
        if (section.points.length) {
          const points = document.createElement('span');
          points.className = 'chapter-points';
          for (const point of section.points) {
            const item = document.createElement('span');
            item.textContent = point;
            points.append(item);
          }
          main.append(points);
        }
        // Only the AI outline judges density, so the badges appear with it and not before.
        if (section.kind) {
          const tag = document.createElement('span');
          tag.className = 'chapter-tag';
          tag.textContent = KIND_LABELS[section.kind];
          main.append(tag);
        }
        if (section.density !== undefined && section.density <= FILLER_DENSITY) {
          button.dataset.filler = 'true';
          button.title = `${section.title}（信息密度低，「只看干货」会跳过）`;
        }
        const time = document.createElement('time');
        time.textContent = formatTime(section.start);
        button.append(number, main, time);
        return button;
      }),
    );
    container.hidden = !sections.length;
    $('#chapter-empty').hidden = Boolean(sections.length);
    // Native entries are the video's own chapters (章); AI entries are content sections (节).
    $('#chapter-count').textContent = `${sections.length} ${kind === 'native' ? '章' : '节'}`;
    $('#chapter-source').textContent = sections.length ? CHAPTER_LABELS[kind] : '内容目录';
    // Native chapters hide the empty state, so keep the AI outline reachable from the heading.
    $('#chapter-outline-btn').hidden = kind !== 'native' || !sections.length;
    // Skipping needs a density judgement, which only the AI outline supplies.
    const rated = sections.some((section) => section.density !== undefined);
    $('#skip-filler').hidden = !rated;
    if (!rated) state.skipFiller = false;
    $('#skip-filler').setAttribute('aria-pressed', String(state.skipFiller));
    if (focused) {
      const replacement = [...container.querySelectorAll<HTMLButtonElement>('.chapter-card')].find(
        (button) => button.dataset.seek === focused.dataset.seek && button.title === focused.title,
      );
      (replacement || (chapters.length ? container : $('#chapter-empty'))).focus({
        preventScroll: true,
      });
    }
  }
  updateChapterPlayback();
}

/**
 * Questions to hold in mind before watching. Answers stay collapsed on purpose: looking for the
 * answer while watching is what makes it stick, so revealing one is a deliberate second click.
 */
function renderGuide(): void {
  const questions = state.guide?.questions ?? [];
  const list = $('#guide-list');
  list.hidden = !questions.length;
  $('#guide-empty').hidden = Boolean(questions.length);
  $('#guide-refresh').hidden = !questions.length;
  list.replaceChildren(
    ...questions.map((item, index) => {
      const card = document.createElement('div');
      card.className = 'guide-card';

      const row = document.createElement('button');
      row.className = 'guide-row';
      row.dataset.guide = String(index);
      row.setAttribute('aria-expanded', 'false');
      row.setAttribute('aria-controls', `guide-answer-${index}`);
      const number = document.createElement('span');
      number.className = 'guide-index';
      number.textContent = String(index + 1).padStart(2, '0');
      const text = document.createElement('span');
      text.className = 'guide-text';
      text.textContent = item.question;
      const caret = document.createElement('span');
      caret.className = 'guide-caret';
      caret.setAttribute('aria-hidden', 'true');
      caret.textContent = '答案';
      row.append(number, text, caret);

      const jump = document.createElement('button');
      jump.className = 'guide-jump';
      jump.dataset.seek = String(item.start);
      jump.textContent = `${formatTime(item.start)} ↗`;
      jump.title = '跳到视频中回答这个问题的位置';

      const answer = document.createElement('div');
      answer.className = 'guide-answer';
      answer.id = `guide-answer-${index}`;
      answer.hidden = true;
      answer.textContent = item.answer || '视频里没有正面回答这个问题，可以跳到这个时间点自己看看。';

      card.append(row, jump, answer);
      return card;
    }),
  );
}

function toggleGuide(index: number): void {
  const row = $('#guide-list').querySelector<HTMLButtonElement>(`[data-guide="${index}"]`);
  const answer = document.getElementById(`guide-answer-${index}`);
  if (!row || !answer) return;
  const open = answer.hidden;
  answer.hidden = !open;
  row.setAttribute('aria-expanded', String(open));
  row.querySelector('.guide-caret')!.textContent = open ? '收起' : '答案';
}

const TERM_LABELS: Record<TermKind, string> = {
  concept: '概念',
  person: '人物',
  tool: '工具',
  work: '作品',
  term: '术语',
};

/** A reference list that doubles as navigation: every entry knows where it first appears. */
function renderGlossary(): void {
  const terms = state.glossary?.terms ?? [];
  const list = $('#glossary-list');
  list.hidden = !terms.length;
  $('#glossary-empty').hidden = Boolean(terms.length);
  $('#glossary-refresh').hidden = !terms.length;
  $('#glossary-count').textContent = terms.length ? `${terms.length} 条` : '';
  // The footer entry carries the count, because the view it opens is no longer visible in the bar.
  $('#glossary-badge').textContent = terms.length ? String(terms.length) : '';
  list.replaceChildren(
    ...terms.map((entry) => {
      const card = document.createElement('div');
      card.className = 'term-card';

      const head = document.createElement('div');
      head.className = 'term-head';
      const kind = document.createElement('span');
      kind.className = 'term-kind';
      kind.textContent = TERM_LABELS[entry.kind];
      const name = document.createElement('span');
      name.className = 'term-name';
      name.textContent = entry.term;
      head.append(kind, name);

      const jump = document.createElement('button');
      jump.className = 'term-jump';
      jump.dataset.seek = String(entry.start);
      jump.textContent = `${formatTime(entry.start)} ↗`;
      jump.title = '跳到它首次出现的位置';

      const meaning = document.createElement('p');
      meaning.className = 'term-meaning';
      meaning.textContent = entry.meaning || '字幕中没有给出解释。';

      card.append(head, jump, meaning);
      return card;
    }),
  );
}

/** Notes from other videos, opened and edited the same way as this video's own. */
function renderVideoClips(video: { videoId: string; title: string; clips: Clip[] }): HTMLElement[] {
  const head = document.createElement('div');
  head.className = 'clip-group';
  const title = document.createElement('span');
  title.className = 'clip-group-title';
  title.textContent = video.title || video.videoId;
  const count = document.createElement('span');
  count.textContent = `${video.clips.length} 条`;
  head.append(title, count);
  const cards = video.clips.map((clip) => {
    const card = document.createElement('div');
    card.className = 'clip-card';
    const row = document.createElement('div');
    row.className = 'clip-head';
    const url = watchUrl(video.videoId, clip.start);
    if (video.videoId === state.video?.id) {
      const jump = document.createElement('button');
      jump.className = 'term-jump';
      jump.dataset.seek = String(clip.start);
      jump.textContent = `${formatTime(clip.start)} ↗`;
      row.append(jump);
    } else if (url) {
      const link = document.createElement('a');
      link.className = 'term-jump';
      link.href = url;
      link.target = '_blank';
      link.rel = 'noreferrer noopener';
      link.textContent = `${formatTime(clip.start)} ↗`;
      row.append(link);
    }
    const remove = document.createElement('button');
    remove.className = 'text-button clip-remove';
    remove.dataset.unclip = noteRef(video.videoId, clip.id);
    remove.textContent = '删除';
    row.append(remove);
    const body = document.createElement('button');
    body.className = 'clip-body';
    body.dataset.note = noteRef(video.videoId, clip.id);
    const text = document.createElement('p');
    text.className = 'clip-text';
    text.textContent = clip.text;
    body.append(text);
    if (clip.translation) {
      const line = document.createElement('p');
      line.className = 'clip-translation';
      line.textContent = clip.translation;
      body.append(line);
    }
    card.append(row, body);
    const comment = document.createElement('button');
    comment.className = clip.comment ? 'clip-comment-open' : 'clip-comment-open is-empty';
    comment.dataset.note = noteRef(video.videoId, clip.id);
    comment.textContent = clip.comment || '写下你的想法…';
    card.append(comment);
    return card;
  });
  return [head, ...cards];
}

/** How many of the account's other videos one visit to this view will fetch. */
const NOTE_PULL_LIMIT = 30;

function paintAllClips(videos: VideoClips[], titles: Map<string, string>, status = ''): void {
  const total = videos.reduce((count, video) => count + video.clips.length, 0);
  $('#notes-list').hidden = !total;
  $('#notes-empty').hidden = Boolean(total);
  $('#notes-count').textContent = status || (total ? `${videos.length} 个视频 · ${total} 条` : '');
  $<HTMLButtonElement>('#notes-clear').hidden = true;
  $('#notes-list').replaceChildren(
    ...videos.flatMap((video) =>
      renderVideoClips({ ...video, title: video.title || titles.get(video.videoId) || '' }),
    ),
  );
}

/**
 * This machine's notes paint first, then the account's index says which other videos have notes
 * and those are fetched. The account stores one item per video and cannot list them, so the index
 * is the only way a machine that never opened a video knows there is anything to ask for.
 */
async function renderAllClips(): Promise<void> {
  const titles = new Map<string, string>();
  let videos = await readAllClips();
  if (state.notesScope !== 'all') return;
  paintAllClips(videos, titles);
  const known = await syncNoteIndex(cloud);
  if (state.notesScope !== 'all') return;
  for (const video of known) titles.set(video.videoId, video.title);
  const missing = known
    .filter((video) => !videos.some((held) => held.videoId === video.videoId))
    .slice(0, NOTE_PULL_LIMIT);
  if (!missing.length) return paintAllClips(videos, titles);
  paintAllClips(videos, titles, `正在从账号载入另外 ${missing.length} 个视频的笔记…`);
  for (const video of missing) {
    if (state.notesScope !== 'all') return;
    // One unreachable video must not stop the rest from arriving.
    await syncClips(video.videoId, cloud).catch(() => undefined);
  }
  videos = await readAllClips();
  if (state.notesScope !== 'all') return;
  paintAllClips(videos, titles);
}

function setNotesScope(scope: 'video' | 'all'): void {
  state.notesScope = scope;
  $('#notes-scope-video').setAttribute('aria-selected', String(scope === 'video'));
  $('#notes-scope-all').setAttribute('aria-selected', String(scope === 'all'));
  renderClips();
}

function renderClips(): void {
  if (state.notesScope === 'all') {
    void renderAllClips().catch((error: unknown) => notice(errorMessage(error), true));
    return;
  }
  const list = $('#notes-list');
  const clips = state.clips;
  list.hidden = !clips.length;
  $('#notes-empty').hidden = Boolean(clips.length);
  $('#notes-count').textContent = clips.length ? `${clips.length} 条` : '';
  $('#notes-badge').textContent = clips.length ? String(clips.length) : '';
  $<HTMLButtonElement>('#notes-clear').hidden = !clips.length;
  list.replaceChildren(
    ...clips.map((clip) => {
      const card = document.createElement('div');
      card.className = 'clip-card';

      const head = document.createElement('div');
      head.className = 'clip-head';
      const jump = document.createElement('button');
      jump.className = 'term-jump';
      jump.dataset.seek = String(clip.start);
      jump.textContent = `${formatTime(clip.start)} ↗`;
      const remove = document.createElement('button');
      remove.className = 'text-button clip-remove';
      remove.dataset.unclip = noteRef(state.video?.id ?? '', clip.id);
      remove.textContent = '删除';
      head.append(jump, remove);

      const body = document.createElement('button');
      body.className = 'clip-body';
      body.dataset.note = noteRef(state.video?.id ?? '', clip.id);
      const text = document.createElement('p');
      text.className = 'clip-text';
      text.textContent = clip.text;
      body.append(text);
      if (clip.translation) {
        const translation = document.createElement('p');
        translation.className = 'clip-translation';
        translation.textContent = clip.translation;
        body.append(translation);
      }
      card.append(head, body);

      // A two-row edit box turned every note into a form and a long AI explanation into a
      // scrollbar. The card reads; the drawer, which has the room, is where it is written.
      const comment = document.createElement('button');
      comment.className = clip.comment ? 'clip-comment-open' : 'clip-comment-open is-empty';
      comment.dataset.note = noteRef(state.video?.id ?? '', clip.id);
      comment.textContent = clip.comment || '写下你的想法…';
      card.append(comment);
      return card;
    }),
  );
}

/** The account's copy of notes and results, reached through the worker, which holds the session. */
const cloud: Cloud = {
  get: (key) => send({ type: 'sync:get', key }),
  put: (key, value, updatedAt) => send({ type: 'sync:put', key, value, updatedAt }),
};

/**
 * Clips belong to the video, not to a session, so they are reloaded whenever it changes: this
 * machine's copy first so the list paints at once, then the account's if that one is newer.
 */
async function loadClips(videoId: string): Promise<void> {
  const show = (clips: Clip[]) => {
    // Which video these belong to is the only thing that can make them stale. loadVersion counts
    // transcript loads, and updateVideo() starts one right after calling this — so guarding on it
    // discarded every result, and a video's notes never came back after it was reopened.
    if (state.video?.id !== videoId) return;
    // Re-rendering an unchanged list would take focus from a comment being typed.
    if (JSON.stringify(clips) === JSON.stringify(state.clips)) return;
    state.clips = clips;
    renderClips();
  };
  show(await readClips(videoId));
  show(await syncClips(videoId, cloud));
}

/**
 * A note names the video it belongs to, so editing one from the 全部视频 list is the same work as
 * editing one from this video: read that video's notes, write them back, push them up.
 */
function noteRef(videoId: string, id: string): string {
  return `${videoId}|${id}`;
}

async function clipsOf(videoId: string): Promise<Clip[]> {
  return videoId === state.video?.id ? state.clips : await readClips(videoId);
}

async function saveClips(videoId: string, clips: Clip[]): Promise<void> {
  if (videoId === state.video?.id) state.clips = clips;
  renderClips();
  await writeClips(videoId, clips);
  // Already safe on this machine. If the upload fails, the next sync finds these newer and retries.
  void pushClips(videoId, cloud).catch(() => undefined);
  // And the account's index learns what this video now holds, so another machine sees it too.
  void syncNoteIndex(cloud).catch(() => undefined);
}

async function persistClips(): Promise<void> {
  if (!state.video) return;
  await saveClips(state.video.id, state.clips);
}

async function removeClip(ref: string): Promise<void> {
  const [videoId = '', id = ''] = ref.split('|');
  if (!videoId || !id) return;
  const clips = await clipsOf(videoId);
  await saveClips(
    videoId,
    clips.filter((clip) => clip.id !== id),
  );
}

async function editComment(ref: string, comment: string): Promise<void> {
  const [videoId = '', id = ''] = ref.split('|');
  if (!videoId || !id) return;
  const clips = await clipsOf(videoId);
  const clip = clips.find((item) => item.id === id);
  if (!clip || clip.comment === comment) return;
  await saveClips(
    videoId,
    clips.map((item) => (item === clip ? { ...item, comment } : item)),
  );
}

/** Keeps the line, its translation and where it came from, so a note stands on its own later. */
async function addClip(
  start: number,
  text: string,
  translation: string,
  comment = '',
): Promise<void> {
  if (!state.video || !text.trim()) return;
  const kept = state.clips.find((clip) => clip.start === start && clip.text === text);
  if (kept) {
    // Explaining a line that is already a note is worth something: it fills in what was empty.
    if (!comment || kept.comment) {
      toast('这一条已经在笔记里了');
      return;
    }
    kept.comment = comment;
    renderClips();
    await persistClips();
    toast('已把 AI 解释补进这条笔记');
    return;
  }
  state.clips = [
    ...state.clips,
    {
      id: crypto.randomUUID(),
      start,
      text: text.trim(),
      translation: translation.trim(),
      comment,
      createdAt: new Date().toISOString(),
      videoId: state.video.id,
      videoTitle: state.video.title,
    },
  ].sort((a, b) => a.start - b.start);
  renderClips();
  await persistClips();
  toast('已存为笔记');
}

async function clipActiveCue(): Promise<void> {
  const cue = state.transcript?.cues[state.activeCue];
  if (!cue) {
    notice('还没有正在播放的字幕可以存。');
    return;
  }
  await addClip(cue.start, cue.text, state.translations[cue.id] ?? '');
}

async function clipSelection(): Promise<void> {
  const cue = state.transcript?.cues[selectedCue];
  if (!cue || !selectedTerm) return;
  hideExplain();
  await addClip(cue.start, selectedTerm, state.translations[cue.id] ?? '');
}

async function generateGlossary(): Promise<void> {
  const context = aiContext();
  const result = await run({ task: 'glossary', ...context }, Boolean(state.glossary));
  if (result?.task !== 'glossary') return;
  state.glossary = result.glossary;
  renderGlossary();
  showTab('glossary');
  toast(`已整理 ${result.glossary.terms.length} 条术语`);
}

async function generateGuide({ quiet = false } = {}): Promise<void> {
  const context = aiContext();
  const result = await run({ task: 'guide', ...context }, quiet ? false : Boolean(state.guide));
  if (result?.task !== 'guide') return;
  state.guide = result.guide;
  renderGuide();
  // An automatic run must not yank the viewer out of whatever they were reading.
  if (quiet) return;
  showTab('guide');
  toast(`已生成 ${result.guide.questions.length} 个引导问题`);
}

/**
 * 引导提问 is the first thing in the tab bar, so it should be there when you arrive rather than
 * behind a button. Silent on purpose: an unconfigured key must not pop the settings dialog just
 * because a video was opened, and a cache hit costs nothing on a video seen before.
 */
/**
 * Whatever was already generated for this video, put back on screen. Only reads: this machine's
 * cache first, then the account's copy, never a provider — opening a video must not spend anyone's
 * credits, and an automatic run would also hold the one job slot the next click needs.
 */
async function restoreSavedResults(version: number): Promise<void> {
  const settings = state.settings;
  const video = state.video;
  const transcript = state.transcript;
  if (!settings || !video || !transcript || !aiReady(settings)) return;
  const language = $<HTMLSelectElement>('#target-language').value;
  const context = { video, transcript, language };
  const requests: AiRequest[] = [
    { task: 'guide', ...context },
    { task: 'outline', ...context },
    { task: 'glossary', ...context },
    { task: 'summarize', ...context, prompt: settings.prompt },
  ];
  for (const request of requests) {
    if (version !== state.loadVersion) return;
    const found = await findSaved(request, settings).catch(() => undefined);
    if (!found || version !== state.loadVersion) continue;
    if (found.task === 'guide') {
      state.guide = found.guide;
      renderGuide();
    } else if (found.task === 'outline') {
      state.outline = found.outline;
      renderChapters();
    } else if (found.task === 'glossary') {
      state.glossary = found.glossary;
      renderGlossary();
    } else if (found.task === 'summarize') {
      renderSummary(found.summary);
    }
  }
}

/** An explicit jump is honoured even into filler: the viewer asked to be there. */
let honourSeekUntil = 0;

/** The next section worth watching, or undefined if the rest of the video is filler. */
function nextWorthWatching(from: number): number | undefined {
  for (let index = from; index < chapters.length; index += 1) {
    const density = chapters[index]?.density;
    if (density === undefined || density > FILLER_DENSITY) return index;
  }
  return undefined;
}

function updateChapterPlayback(restoreCurrent = false): void {
  const container = $('#chapter-list');
  let index = chapters.length - 1;
  while (index >= 0 && chapters[index]!.start > (state.video?.currentTime || 0)) index--;
  if (index !== activeChapter) {
    const entered = chapters[index];
    container.querySelector('[aria-current]')?.removeAttribute('aria-current');
    activeChapter = index;
    container.querySelector(`[data-chapter="${index}"]`)?.setAttribute('aria-current', 'true');
    // Only skip a section playback drifted into by itself. Skipping while paused, or right after
    // the viewer jumped somewhere on purpose, would fight whoever is holding the timeline.
    if (
      state.skipFiller &&
      entered &&
      !state.video?.paused &&
      Date.now() > honourSeekUntil &&
      entered.density !== undefined &&
      entered.density <= FILLER_DENSITY
    ) {
      const target = nextWorthWatching(index + 1);
      const destination = target === undefined ? undefined : chapters[target];
      if (destination) {
        void seek(destination.start).catch((error: unknown) => notice(errorMessage(error), true));
        toast(`已跳过「${entered.title}」`);
        return;
      }
    }
  }
  if (!restoreCurrent || state.tab !== 'chapters') return;
  const current = container.querySelector<HTMLElement>(`[data-chapter="${index}"]`);
  if (!current) return;
  const offset = current.getBoundingClientRect().top - container.getBoundingClientRect().top;
  container.scrollTo({
    top: container.scrollTop + offset - container.clientHeight / 3,
    behavior: 'instant',
  });
}

function trackFingerprint(video: VideoInfo): string {
  return JSON.stringify(
    video.tracks
      .map(({ id, language, automatic }) => JSON.stringify([id, language, automatic]))
      .sort(),
  );
}

/** Retry newly discovered tracks once; repeated player clock updates never trigger requests. */
function recoverTranscriptIfAvailable(): void {
  const video = state.video;
  if (!video?.tracks.length || state.loading || state.transcript?.cues.length) return;
  if (attemptedTrackSets.has(trackFingerprint(video))) return;
  void loadTranscript();
}

function toast(message: string): void {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  toastTimer = window.setTimeout(() => $('#toast').classList.remove('visible'), 3500);
}

function notice(message: string, error = false): void {
  const target = $('#notice');
  target.textContent = message;
  target.hidden = !message;
  target.classList.toggle('error', error);
}

function on(
  selector: string,
  event: string,
  handler: (event: Event) => void | Promise<void>,
): void {
  $(selector).addEventListener(event, (input) => {
    Promise.resolve()
      .then(() => handler(input))
      .catch((error: unknown) => notice(errorMessage(error), true));
  });
}

async function command(command: PlayerCommand): Promise<void> {
  if (tabId < 0) return;
  await send({ type: 'player:command', tabId, command });
}

async function seek(time: number): Promise<void> {
  await command({ action: 'seek', time });
  if (state.video) state.video.currentTime = time;
  // The page clears the previous overlay on seek, even when the cue stays the same.
  lastOverlay = '';
  updatePlayback();
}

function showTab(tab: Tab): void {
  state.tab = tab;
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) => {
    const selected = button.dataset.tab === tab;
    // The footer entries are buttons, not tabs: aria-selected would be meaningless on them, and
    // taking them out of the tab order would strand them.
    if (button.classList.contains('footer-tab')) {
      button.setAttribute('aria-pressed', String(selected));
      button.classList.toggle('is-active', selected);
      return;
    }
    button.setAttribute('aria-selected', String(selected));
    if (button.getAttribute('role') === 'tab') button.tabIndex = selected ? 0 : -1;
  });
  for (const name of VIEWS) {
    $(`#view-${name}`).hidden = name !== tab;
  }
  closeExport();
  // Coming back to the subtitles means wanting to read along again: whatever turned following off
  // — a scroll to look something up, a page button — was about the visit that just ended.
  if (tab === 'transcript') {
    setFollow(true);
    followCurrent();
  }
  if (tab === 'chapters') updateChapterPlayback(true);
}

function resetResults(): void {
  state.summary = undefined;
  state.outline = undefined;
  state.guide = undefined;
  state.glossary = undefined;
  renderChapters();
  renderGuide();
  renderGlossary();
  state.summaryPrompt = '';
  $('#summary-content').className = 'empty';
  $('#summary-content').innerHTML =
    '<div class="empty-mark">AI</div><h2>把整片视频，读成一页笔记</h2><p>按章节整理观点、案例和可执行建议，每条都带时间点。</p>';
  syncExportMenu();
  $('#summarize-btn').textContent = '生成视频总结';
}

function resetVideo(): void {
  state.loadVersion++;
  closeExplainPanel();
  attemptedTrackSets.clear();
  state.job?.abort();
  cancelTranslator();
  state.transcript = undefined;
  state.translations = {};
  state.activeCue = -1;
  state.windowStart = 0;
  state.query = '';
  state.loading = false;
  $('#google-web-fallback').hidden = true;
  $<HTMLInputElement>('#search').value = '';
  $('#messages').innerHTML =
    '<div class="empty chat-welcome"><div class="empty-mark">AI</div><h2>关于这段视频，你想了解什么？</h2><p>AI 会参考当前字幕，并附上回看时间点。</p></div>';
  resetResults();
  lastOverlay = '';
  void command({
    action: 'overlay',
    original: '',
    translated: '',
    visible: false,
    mode: state.displayMode,
    enabled: false,
    start: 0,
    end: 0,
  }).catch(() => {});
}

function updateVideo(video: VideoInfo): void {
  const changed = state.video?.id !== video.id;
  if (changed) resetVideo();
  const tracksChanged = JSON.stringify(state.video?.tracks) !== JSON.stringify(video.tracks);
  state.video = video;
  if (changed) {
    state.clips = [];
    renderClips();
    void loadClips(video.id).catch(() => undefined);
  }
  renderChapters();
  $('#video-title').textContent = video.title;
  $('#video-author').textContent = video.author || 'YouTube';
  $('#video-duration').textContent = video.duration > 0 ? formatTime(video.duration) : '时长待确认';
  if (changed || tracksChanged) {
    const select = $<HTMLSelectElement>('#track-select');
    const previous = select.value;
    select.replaceChildren(new Option('自动选择字幕', ''));
    for (const track of video.tracks) {
      select.add(new Option(track.name + (track.automatic ? ' · 自动' : ''), track.id));
    }
    if (video.tracks.some((track) => track.id === previous)) select.value = previous;
  }
  if (changed) void loadTranscript();
  else {
    updatePlayback();
    if (tracksChanged) recoverTranscriptIfAvailable();
  }
}

async function loadTranscript(): Promise<void> {
  const video = state.video;
  if (!video) return;
  if (video.tracks.length) attemptedTrackSets.add(trackFingerprint(video));
  const version = ++state.loadVersion;
  state.job?.abort();
  state.loading = true;
  updateActions();
  $('#source-state').textContent = '正在读取字幕';
  notice('');
  if (!state.transcript)
    $('#transcript-list').innerHTML =
      '<div class="empty"><div class="empty-mark">CC</div><h2>正在读取字幕</h2><p>从当前视频读取完整字幕轨…</p></div>';
  try {
    const transcript = await send<Transcript>({
      type: 'transcript:get',
      tabId,
      trackId: $<HTMLSelectElement>('#track-select').value || undefined,
    });
    if (version !== state.loadVersion || video.id !== state.video?.id) return;
    installTranscript(transcript);
  } catch (error) {
    if (version !== state.loadVersion) return;
    $('#source-state').textContent = state.transcript ? '保留已载入字幕' : '未获取字幕';
    notice(errorMessage(error), true);
    if (!state.transcript) {
      $('#transcript-list').innerHTML =
        `<div class="empty"><div class="empty-mark">CC</div><h2>暂时无法读取字幕</h2><p>${esc(errorMessage(error))}</p><p>可以稍后重新读取，或导入 SRT / VTT 字幕继续学习。</p><button class="button" data-retry-transcript>重新读取字幕</button><button class="button" data-import>导入字幕文件</button></div>`;
    }
  } finally {
    if (version === state.loadVersion) state.loading = false;
    updateActions();
    // Track discovery can finish while the original empty-track request is still pending.
    if (version === state.loadVersion) recoverTranscriptIfAvailable();
  }
}

function installTranscript(transcript: Transcript): void {
  if (!transcript.cues.length) throw new Error('字幕文件没有可用的句子。');
  state.transcript = transcript;
  state.translations = {};
  $('#google-web-fallback').hidden = true;
  state.query = '';
  state.windowStart = 0;
  state.activeCue = -1;
  $<HTMLInputElement>('#search').value = '';
  resetResults();
  setFollow(true);
  $('#cue-count').textContent = String(transcript.cues.length);
  $('#source-state').textContent = transcript.source === 'import' ? '已导入字幕' : '已读取字幕';
  const first = transcript.cues[0];
  const last = transcript.cues.at(-1);
  $('#caption-range').textContent =
    first && last ? `${formatTime(first.start)} - ${formatTime(last.end)}` : '';
  // Partial coverage is not worth a banner: it is jargon at the moment the viewer just wants to
  // read, and the fact is already stated where it changes a decision — the summary carries a
  // 「当前字幕范围总结」 badge, and export stays disabled.
  notice('');
  renderTranscript();
  updatePlayback();
  updateActions();
  cancelTranslator();
  const version = state.loadVersion;
  void primeTranslations(version).finally(() => {
    if (version === state.loadVersion) maybeTranslate();
  });
  void restoreSavedResults(version).catch(() => undefined);
}

function setFollow(follow: boolean): void {
  state.follow = follow;
  $('#follow-btn').classList.toggle('is-active', follow);
  $('#follow-btn').setAttribute('aria-pressed', String(follow));
  $('#follow-btn').textContent = follow ? '跟随播放' : '恢复跟随';
}

/**
 * Where each glossary term first shows up, so marking costs one lookup per term instead of
 * scanning every rendered cue against every term.
 */
function glossaryMarks(cues: Cue[]): Map<number, GlossaryTerm[]> {
  const marks = new Map<number, GlossaryTerm[]>();
  for (const term of state.glossary?.terms ?? []) {
    const index = findCueIndex(cues, term.start);
    if (index < 0) continue;
    const at = marks.get(index);
    if (at) at.push(term);
    else marks.set(index, [term]);
  }
  return marks;
}

/**
 * Ranges are collected against the clean text and spliced in one pass. Wrapping them one at a
 * time would let a later term match inside an earlier term's title attribute.
 */
function markTerms(escaped: string, terms: GlossaryTerm[], lookup = ''): string {
  const haystack = escaped.toLocaleLowerCase();
  const ranges: { at: number; end: number; className: string; title: string }[] = [];
  // The word just looked up is marked first, so a glossary term never takes its place.
  const needle = esc(lookup).toLocaleLowerCase();
  const found = needle ? haystack.indexOf(needle) : -1;
  if (found >= 0)
    ranges.push({
      at: found,
      end: found + needle.length,
      className: 'word-hit',
      title: `正在解释「${lookup}」`,
    });
  for (const term of terms) {
    const text = esc(term.term).toLocaleLowerCase();
    if (!text) continue;
    const at = haystack.indexOf(text);
    if (at < 0) continue;
    const end = at + text.length;
    // A term already covered by an earlier mark is skipped rather than nested.
    if (ranges.some((range) => at < range.end && range.at < end)) continue;
    ranges.push({
      at,
      end,
      className: 'term-mark',
      title: `${TERM_LABELS[term.kind]} · ${term.meaning || '字幕中没有给出解释。'}`,
    });
  }
  ranges.sort((a, b) => a.at - b.at);
  let output = '';
  let cursor = 0;
  for (const { at, end, className, title } of ranges) {
    output += `${escaped.slice(cursor, at)}<span class="${className}" title="${esc(title)}">${escaped.slice(at, end)}</span>`;
    cursor = end;
  }
  return output + escaped.slice(cursor);
}

let selectedTerm = '';
let selectedCue = -1;

function hideExplain(): void {
  $('#explain-bubble').hidden = true;
}

/** Anchors the bubble to the selection, kept inside the panel's own viewport. */
function placeExplain(rect: DOMRect): void {
  const bubble = $('#explain-bubble');
  bubble.hidden = false;
  const width = bubble.offsetWidth;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  const above = rect.top > bubble.offsetHeight + 16;
  bubble.style.left = `${left}px`;
  bubble.style.top = `${above ? rect.top - bubble.offsetHeight - 8 : rect.bottom + 8}px`;
}

/** True when the current selection lies inside this element, which means a drag ended here. */
function selectionInside(element: Element): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.toString().trim()) return false;
  const node = selection.anchorNode;
  const anchor = node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : node?.parentElement;
  return Boolean(anchor && element.contains(anchor));
}

async function copyText(text: string, label: string): Promise<void> {
  if (!text.trim()) throw new Error('没有可复制的内容。');
  await navigator.clipboard.writeText(text);
  toast(label);
}

/** Both languages, because the pair is what makes the line worth keeping. */
async function copyCue(index: number): Promise<void> {
  const cue = state.transcript?.cues[index];
  if (!cue) throw new Error('这一句已经不在当前字幕里了。');
  const translation = state.translations[cue.id];
  await copyText([cue.text, translation].filter(Boolean).join('\n'), '已复制整句');
}

function offerExplain(): void {
  const selection = window.getSelection();
  const text = selection?.toString().trim() ?? '';
  // Long selections are sentences, not terms; explaining them is what AI 问答 is for.
  if (!selection || selection.isCollapsed || !text || text.length > 80) return hideExplain();
  const node = selection.anchorNode;
  const element = node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : node?.parentElement;
  const cue = element?.closest<HTMLElement>('[data-cue]');
  if (!cue || !$('#transcript-list').contains(cue)) return hideExplain();
  selectedTerm = text;
  selectedCue = Number(cue.dataset.cue);
  const trigger = document.createElement('button');
  trigger.className = 'explain-trigger';
  trigger.dataset.explain = 'true';
  trigger.textContent = `解释「${text.length > 14 ? text.slice(0, 14) + '…' : text}」`;
  const copy = document.createElement('button');
  copy.className = 'explain-trigger';
  copy.textContent = '复制';
  copy.addEventListener('click', () => {
    void copyText(text, '已复制').catch((error: unknown) => notice(errorMessage(error), true));
    hideExplain();
  });
  const clip = document.createElement('button');
  clip.className = 'explain-trigger';
  clip.dataset.clipSelection = 'true';
  clip.textContent = '存为笔记';
  $('#explain-bubble').replaceChildren(trigger, copy, clip);
  placeExplain(selection.getRangeAt(0).getBoundingClientRect());
}

/** Occurrences are found locally: an exact search is both cheaper and more honest than asking. */
function occurrences(term: string): number[] {
  const cues = state.transcript?.cues ?? [];
  const needle = term.toLocaleLowerCase();
  const found: number[] = [];
  for (const cue of cues) {
    if (cue.text.toLocaleLowerCase().includes(needle)) found.push(cue.start);
    if (found.length >= 8) break;
  }
  return found;
}

/**
 * A word is read straight from the text node under the pointer, so the subtitle list keeps its
 * plain markup: no per-word spans to render, to search around, or to keep in step with term marks.
 * Intl.Segmenter also knows where a word ends in scripts that do not write spaces.
 */
const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

function wordAtPoint(x: number, y: number): string {
  const caret = document.caretPositionFromPoint(x, y);
  const node = caret?.offsetNode;
  if (!caret || node?.nodeType !== Node.TEXT_NODE) return '';
  const part = segmenter.segment(node.textContent ?? '').containing(caret.offset);
  return part?.isWordLike ? part.segment : '';
}

const SPEAKER_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2 4.6 5H2.4A.9.9 0 0 0 1.5 6v4a.9.9 0 0 0 .9.9h2.2L8 13.8zM11 5.4a3.6 3.6 0 0 1 0 5.2M12.9 3.3a6.3 6.3 0 0 1 0 9.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>';

/** Chrome speaks it on the machine: no service to call, no key, and it works offline. */
function speak(text: string, lang: string): void {
  try {
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    speechSynthesis.speak(utterance);
  } catch {
    // A machine with no installed voice simply stays quiet.
  }
}

/** The subtitle's own language, so a French video is not read out in English. */
function speechLang(): string {
  const language = state.transcript?.language?.trim() || 'en';
  return language.toLowerCase().startsWith('en') && !language.includes('-') ? 'en-US' : language;
}

function speakButton(text: string, label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'speak-button';
  button.dataset.speak = text;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.innerHTML = SPEAKER_ICON;
  return button;
}

/** What the drawer is explaining, so a reply for something else can no longer overwrite it. */
let explainSubject:
  | {
      term: string;
      cue: number;
      mode: ExplainMode;
      /** From a dictionary, in a moment. */
      entry?: WordEntry;
      /** From the model, a second or two later: which of those senses this line is using. */
      explanation?: Explanation;
    }
  | undefined;

function closeExplainPanel(): void {
  $('#explain-panel').classList.remove('is-open');
  const marked = explainSubject;
  explainSubject = undefined;
  // The mark says which word the drawer is explaining, so it goes when the drawer does.
  if (marked && state.transcript) renderTranscript();
}

/** The line it came from: what makes this a video dictionary rather than a dictionary. */
function sourceQuote(cue: Cue): HTMLElement {
  const quote = document.createElement('button');
  quote.className = 'explain-source';
  quote.dataset.seek = String(cue.start);
  const time = document.createElement('time');
  time.textContent = formatTime(cue.start);
  const text = document.createElement('span');
  text.className = 'explain-source-text';
  text.textContent = cue.text;
  quote.append(time, text);
  const translation = state.translations[cue.id];
  if (translation) {
    const line = document.createElement('span');
    line.className = 'explain-source-translation';
    line.textContent = translation;
    quote.append(line);
  }
  return quote;
}

function explainSection(label: string, text: string): HTMLElement {
  const block = document.createElement('section');
  block.className = 'explain-section';
  const heading = document.createElement('h3');
  heading.textContent = label;
  const body = document.createElement('p');
  body.className = 'explain-meaning';
  body.textContent = text;
  block.append(heading, body);
  return block;
}

function renderSense(sense: WordSense): HTMLElement {
  const card = document.createElement('div');
  card.className = 'sense-card';
  const head = document.createElement('div');
  head.className = 'sense-head';
  if (sense.pos) {
    const pos = document.createElement('span');
    pos.className = 'sense-pos';
    pos.textContent = sense.pos;
    head.append(pos);
  }
  const gloss = document.createElement('span');
  gloss.className = 'sense-gloss';
  gloss.textContent = sense.gloss;
  head.append(gloss);
  card.append(head);
  for (const [className, value] of [
    ['sense-definition', sense.definition],
    ['sense-example', sense.example],
    ['sense-example-translation', sense.exampleTranslation],
  ] as const) {
    if (!value) continue;
    const line = document.createElement('p');
    line.className = className;
    line.textContent = value;
    if (className === 'sense-example') line.append(speakButton(value, '朗读这句例句'));
    card.append(line);
  }
  return card;
}

function occurrenceRow(spots: number[]): HTMLElement {
  const row = document.createElement('div');
  row.className = 'explain-spots';
  const label = document.createElement('span');
  label.textContent = `全片提到 ${spots.length}${spots.length >= 8 ? '+' : ''} 次`;
  row.append(label);
  for (const start of spots) {
    const jump = document.createElement('button');
    jump.className = 'term-jump';
    jump.dataset.seek = String(start);
    jump.textContent = formatTime(start);
    row.append(jump);
  }
  return row;
}

function renderExplanation(explanation: Explanation, cue: Cue | undefined, mode: ExplainMode): void {
  const parts: HTMLElement[] = [];
  if (mode !== 'sentence') {
    const head = document.createElement('div');
    head.className = 'word-head';
    const name = document.createElement('h2');
    name.className = 'word-name';
    name.textContent = explanation.term;
    head.append(name, speakButton(explanation.term, `朗读「${explanation.term}」`));
    if (explanation.phonetic) {
      const phonetic = document.createElement('span');
      phonetic.className = 'word-phonetic';
      phonetic.textContent = explanation.phonetic;
      head.append(phonetic);
    }
    const kind = document.createElement('span');
    kind.className = 'term-kind';
    kind.textContent = TERM_LABELS[explanation.kind];
    head.append(kind);
    parts.push(head);
  }
  if (cue) parts.push(sourceQuote(cue));
  parts.push(
    explainSection(mode === 'sentence' ? '这句话在说什么' : '在这句里', explanation.meaning),
  );
  const points = explanation.points ?? [];
  if (points.length) {
    const block = document.createElement('section');
    block.className = 'explain-section';
    const heading = document.createElement('h3');
    heading.textContent = '要点';
    const list = document.createElement('dl');
    list.className = 'explain-points';
    for (const point of points) {
      const label = document.createElement('dt');
      label.textContent = point.label;
      const text = document.createElement('dd');
      text.textContent = point.text;
      list.append(label, text);
    }
    block.append(heading, list);
    parts.push(block);
  }
  const senses = explanation.senses ?? [];
  if (senses.length) {
    const block = document.createElement('section');
    block.className = 'explain-section';
    const heading = document.createElement('h3');
    heading.textContent = '词典释义';
    block.append(heading, ...senses.map(renderSense));
    parts.push(block);
  }
  const spots = mode === 'sentence' ? [] : occurrences(explanation.term);
  if (spots.length > 1) parts.push(occurrenceRow(spots));
  $('#explain-panel-body').replaceChildren(...parts);
}

function skeletonLine(width: string): HTMLElement {
  const line = document.createElement('div');
  line.className = 'skeleton skeleton-line';
  line.style.width = width;
  return line;
}

function waitingLine(label: string): HTMLElement {
  const line = document.createElement('p');
  line.className = 'explain-waiting';
  line.textContent = label;
  return line;
}

function explainBlock(label: string, ...body: HTMLElement[]): HTMLElement {
  const block = document.createElement('section');
  block.className = 'explain-section';
  const heading = document.createElement('h3');
  heading.textContent = label;
  block.append(heading, ...body);
  return block;
}

/**
 * Painted as soon as a word is clicked and again as each half lands: the dictionary entry, which
 * takes a moment, and the model's line about which sense this sentence uses, which takes longer.
 * Waiting for both before showing anything is what made a lookup feel slow.
 */
function renderWordCard(subject: NonNullable<typeof explainSubject>, cue: Cue | undefined): void {
  const { term, entry, explanation } = subject;
  const parts: HTMLElement[] = [];
  const head = document.createElement('div');
  head.className = 'word-head';
  const name = document.createElement('h2');
  name.className = 'word-name';
  name.textContent = explanation?.term || term;
  head.append(name, speakButton(term, `朗读「${term}」`));
  if (entry?.phonetic) {
    const phonetic = document.createElement('span');
    phonetic.className = 'word-phonetic';
    phonetic.textContent = `/${entry.phonetic}/`;
    head.append(phonetic);
  }
  if (entry?.translation) {
    const gloss = document.createElement('span');
    gloss.className = 'word-gloss';
    gloss.textContent = entry.translation;
    head.append(gloss);
  }
  parts.push(head);
  if (cue) parts.push(sourceQuote(cue));
  parts.push(
    explainBlock(
      '在这句里',
      explanation
        ? (() => {
            const meaning = document.createElement('p');
            meaning.className = 'explain-meaning';
            meaning.textContent = explanation.meaning;
            return meaning;
          })()
        : waitingLine('AI 正在看这句话怎么用它'),
    ),
  );
  const senses = entry?.senses ?? [];
  if (senses.length)
    parts.push(
      explainBlock(
        '词典释义',
        ...senses.map((sense) => {
          const card = document.createElement('div');
          card.className = 'sense-card';
          const line = document.createElement('div');
          line.className = 'sense-head';
          if (sense.pos) {
            const pos = document.createElement('span');
            pos.className = 'sense-pos';
            pos.textContent = sense.pos;
            line.append(pos);
          }
          const gloss = document.createElement('span');
          gloss.className = 'sense-gloss';
          gloss.textContent = sense.glosses.join('；');
          line.append(gloss);
          card.append(line);
          return card;
        }),
      ),
    );
  else if (!entry) parts.push(explainBlock('词典释义', skeletonLine('70%'), skeletonLine('52%')));
  const spots = occurrences(term);
  if (spots.length > 1) parts.push(occurrenceRow(spots));
  $('#explain-panel-body').replaceChildren(...parts);
}

/**
 * The shape of the answer, sweeping while it is fetched: for a word, its own name is already
 * known, so it is shown for real and only what is still unknown is drawn as a placeholder.
 */
function explainSkeleton(
  term: string,
  mode: ExplainMode,
): { parts: HTMLElement[]; fail: (message: string) => void } {
  const parts: HTMLElement[] = [];
  const status = document.createElement('p');
  status.className = 'explain-waiting';
  status.textContent = mode === 'sentence' ? '正在解释这一句' : '正在查词典';
  if (mode !== 'sentence') {
    const head = document.createElement('div');
    head.className = 'word-head';
    const name = document.createElement('h2');
    name.className = 'word-name';
    name.textContent = term;
    const chip = document.createElement('span');
    chip.className = 'skeleton skeleton-chip';
    head.append(name, chip);
    parts.push(head);
  }
  parts.push(status);
  const body = document.createElement('div');
  body.append(skeletonLine('100%'), skeletonLine('92%'), skeletonLine('60%'));
  parts.push(body);
  if (mode !== 'sentence') {
    for (const width of ['100%', '78%']) {
      const card = document.createElement('div');
      card.className = 'skeleton-card';
      card.append(skeletonLine('40%'), skeletonLine(width), skeletonLine('66%'));
      parts.push(card);
    }
  }
  return {
    parts,
    fail: (message: string) => {
      status.className = 'explain-meaning';
      status.textContent = message;
      for (const part of parts) if (part !== status && !part.contains(status)) part.remove();
    },
  };
}

/**
 * One explanation, waiting where the answer will appear rather than over the video: the drawer
 * slides in with the line already in it, and the placeholder is replaced in place.
 */
async function explainInPanel(term: string, cueIndex: number, mode: ExplainMode): Promise<void> {
  const cues = state.transcript?.cues;
  if (!cues || !state.video || !state.transcript || !term.trim()) return;
  hideExplain();
  const subject: NonNullable<typeof explainSubject> = { term, cue: cueIndex, mode };
  explainSubject = subject;
  renderTranscript();
  const cue = cues[cueIndex];
  $('#explain-panel').classList.add('is-open');
  $('#explain-panel-title').textContent = mode === 'sentence' ? 'AI 解释这一句' : 'AI 词典';
  let waiting: { parts: HTMLElement[]; fail: (message: string) => void } | undefined;
  if (mode === 'word') {
    renderWordCard(subject, cue);
    // The dictionary half owes nothing to the model and arrives in a fraction of the time.
    void lookupWord(term, $<HTMLSelectElement>('#target-language').value, new AbortController().signal)
      .then((entry) => {
        if (explainSubject !== subject) return;
        subject.entry = entry;
        renderWordCard(subject, cue);
      })
      .catch(() => {
        if (explainSubject === subject && !subject.entry) {
          subject.entry = { translation: '', phonetic: '', senses: [] };
          renderWordCard(subject, cue);
        }
      });
  } else {
    waiting = explainSkeleton(term, mode);
    $('#explain-panel-body').replaceChildren(...(cue ? [sourceQuote(cue)] : []), ...waiting.parts);
  }
  $('#explain-panel-body').scrollTop = 0;
  const centre = cueIndex >= 0 ? cueIndex : 0;
  const result = await run({
    task: 'explain',
    video: state.video,
    // A window around the selection: enough context to be specific, small enough to be quick.
    transcript: { ...state.transcript, cues: cues.slice(Math.max(0, centre - 8), centre + 9) },
    term: term.slice(0, 600),
    mode,
    language: $<HTMLSelectElement>('#target-language').value,
  });
  if (explainSubject !== subject) return;
  const failure = state.job ? '正在处理另一个任务，完成后再试一次。' : '这次没有取到解释，请再试一次。';
  if (result?.task !== 'explain') {
    if (!waiting) {
      // The dictionary half may already be on screen; only the model's line is missing.
      subject.explanation = { term, kind: 'term', meaning: failure };
      renderWordCard(subject, cue);
      return;
    }
    waiting.fail(failure);
    return;
  }
  subject.explanation = result.explanation;
  if (mode === 'word') renderWordCard(subject, cue);
  else renderExplanation(result.explanation, cue, mode);
}

async function explainSelection(): Promise<void> {
  // A selection with a space in it is a phrase, and a phrase has no dictionary entry to look up.
  await explainInPanel(selectedTerm, selectedCue, /\s/.test(selectedTerm) ? 'term' : 'word');
}

/**
 * One note in the drawer: the line it came from, then everything written about it, in a box with
 * the room to read and to write. Saving is the same debounce the list used.
 */
async function openNote(ref: string): Promise<void> {
  const [videoId = '', id = ''] = ref.split('|');
  const clip = (await clipsOf(videoId)).find((item) => item.id === id);
  if (!clip) return;
  const here = videoId === state.video?.id;
  explainSubject = undefined;
  $('#explain-panel').classList.add('is-open');
  $('#explain-panel-title').textContent = '笔记';
  const quote = document.createElement(here ? 'button' : 'div');
  quote.className = 'explain-source';
  // Another video's note cannot seek this player, so it links out to where it was taken instead.
  if (here) quote.dataset.seek = String(clip.start);
  const time = document.createElement('time');
  time.textContent = formatTime(clip.start);
  const text = document.createElement('span');
  text.className = 'explain-source-text';
  text.textContent = clip.text;
  quote.append(time, text);
  if (clip.translation) {
    const line = document.createElement('span');
    line.className = 'explain-source-translation';
    line.textContent = clip.translation;
    quote.append(line);
  }
  const label = document.createElement('h3');
  label.textContent = '我的想法与 AI 解释';
  const comment = document.createElement('textarea');
  comment.className = 'note-comment';
  comment.maxLength = 2000;
  comment.placeholder = '写下你的想法…';
  comment.value = clip.comment;
  comment.dataset.comment = ref;
  const remove = document.createElement('button');
  remove.className = 'text-button clip-remove';
  remove.dataset.unclip = ref;
  remove.textContent = '删除这条笔记';
  const parts: HTMLElement[] = [quote, label, comment, remove];
  if (!here) {
    const url = watchUrl(videoId, clip.start);
    if (url) {
      const open = document.createElement('a');
      open.className = 'term-jump';
      open.href = url;
      open.target = '_blank';
      open.rel = 'noreferrer noopener';
      open.textContent = `在 YouTube 打开 ${formatTime(clip.start)} ↗`;
      parts.splice(1, 0, open);
    }
  }
  $('#explain-panel-body').replaceChildren(...parts);
  $('#explain-panel-body').scrollTop = 0;
  comment.focus();
}

/** The explanation is the reason the note is worth keeping, so it is what the note carries. */
function explanationNote(explanation: Explanation, mode: ExplainMode): string {
  const lines: string[] = [];
  if (mode !== 'sentence')
    lines.push(`${explanation.term}${explanation.phonetic ? ` ${explanation.phonetic}` : ''}`);
  lines.push(explanation.meaning);
  for (const sense of explanation.senses ?? [])
    lines.push(
      `${sense.pos ? `${sense.pos} ` : ''}${sense.gloss}${sense.definition ? ` · ${sense.definition}` : ''}`,
    );
  return lines.join('\n');
}

/** A bare word is no use in a notebook, so a sentence is kept as the line it was. */
async function clipExplained(): Promise<void> {
  const subject = explainSubject;
  const cue = state.transcript?.cues[subject?.cue ?? -1];
  if (!subject || !cue) return;
  await addClip(
    cue.start,
    subject.mode === 'sentence' ? cue.text : subject.term,
    state.translations[cue.id] ?? '',
    subject.explanation ? explanationNote(subject.explanation, subject.mode) : '',
  );
}

/** One place to change how the two lines are shown, whichever control asked for it. */
function applyDisplayMode(mode: DisplayMode): void {
  state.displayMode = mode;
  $<HTMLSelectElement>('#display-mode').value = mode;
  renderTranscript();
  updatePlayback();
  followCurrent();
  publishPreferences();
}

function renderTranscript(): void {
  const cues = state.transcript?.cues;
  if (!cues) return;
  const query = state.query.toLocaleLowerCase();
  const indices = cues.flatMap((cue, index) =>
    !query || `${cue.text}\n${state.translations[cue.id] || ''}`.toLocaleLowerCase().includes(query)
      ? [index]
      : [],
  );
  state.windowStart = Math.max(0, Math.min(state.windowStart, Math.max(0, indices.length - 1)));
  const visible = indices.slice(state.windowStart, state.windowStart + WINDOW_SIZE);
  const marks = glossaryMarks(cues);
  const parts: string[] = [];
  if (state.windowStart > 0)
    parts.push('<button class="button wide" data-page="previous">查看更早的字幕 ↑</button>');
  for (const index of visible) {
    const cue = cues[index];
    if (!cue) continue;
    const marked = marks.get(index);
    const lookup = explainSubject?.mode === 'word' && explainSubject.cue === index
      ? explainSubject.term
      : '';
    const source =
      marked || lookup ? markTerms(esc(cue.text), marked ?? [], lookup) : esc(cue.text);
    const original =
      state.displayMode !== 'translated' ? `<span class="original">${source}</span>` : '';
    const translated =
      state.displayMode !== 'original' && state.translations[cue.id]
        ? `<span class="translation">${esc(state.translations[cue.id] || '')}</span>`
        : '';
    const pending =
      !original && !translated
        ? '<span class="translation">还没有译文，可在字幕设置里点「翻译全部」。</span>'
        : '';
    parts.push(
      `<div class="cue-row"><button class="cue${index === state.activeCue ? ' active' : ''}" data-cue="${index}" data-seek="${cue.start}"${index === state.activeCue ? ' aria-current="true"' : ''}><time>${formatTime(cue.start)}</time>${original}${translated}${pending}</button><button class="cue-copy cue-explain" data-explain-cue="${index}" title="让 AI 解释这一句" aria-label="让 AI 解释这一句">✦</button><button class="cue-copy" data-copy-cue="${index}" title="复制整句" aria-label="复制这一句">⧉</button></div>`,
    );
  }
  if (state.windowStart + WINDOW_SIZE < indices.length)
    parts.push('<button class="button wide" data-page="next">查看后续字幕 ↓</button>');
  $('#transcript-list').innerHTML =
    parts.join('') ||
    '<div class="empty"><h2>没有匹配的字幕</h2><p>换一个词试试，或清空搜索返回完整字幕。</p><button class="button" data-search-clear>清空搜索</button></div>';
}

function followCurrent(): void {
  if (!state.follow || state.query || state.activeCue < 0 || state.tab !== 'transcript') return;
  let target = document.querySelector<HTMLElement>(`[data-cue="${state.activeCue}"]`);
  if (!target) {
    state.windowStart = Math.max(0, state.activeCue - 12);
    renderTranscript();
    target = document.querySelector<HTMLElement>(`[data-cue="${state.activeCue}"]`);
  }
  if (!target) return;
  const container = $('#transcript-list');
  const rect = target.getBoundingClientRect();
  const parent = container.getBoundingClientRect();
  if (rect.top < parent.top + 25 || rect.bottom > parent.bottom - 45) {
    container.scrollTo({
      top: container.scrollTop + rect.top - parent.top - container.clientHeight / 3,
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    });
  }
}

function updatePlayback(): void {
  publishPreferences();
  updateChapterPlayback();
  const cues = state.transcript?.cues;
  if (!cues || !state.video) return;
  const index = findCueIndex(cues, state.video.currentTime);
  if (index !== state.activeCue) {
    document.querySelector('.cue.active')?.classList.remove('active');
    document.querySelector('.cue[aria-current]')?.removeAttribute('aria-current');
    state.activeCue = index;
    const current = document.querySelector(`[data-cue="${index}"]`);
    current?.classList.add('active');
    current?.setAttribute('aria-current', 'true');
    followCurrent();
  }
  const cue = cues[index];
  const enabled = $<HTMLInputElement>('#overlay-enabled').checked;
  const overlay = {
    original: state.displayMode === 'translated' ? '' : cue?.text || '',
    translated: state.displayMode === 'original' ? '' : state.translations[cue?.id || ''] || '',
    visible: enabled && Boolean(cue),
    // Sent even when there is nothing to show: the overlay sizes itself from the mode, not from
    // the text, which is what keeps the video still.
    mode: state.displayMode,
    enabled,
    start: cue?.start ?? 0,
    end: cue?.end ?? 0,
  };
  const identity = JSON.stringify(overlay);
  if (identity !== lastOverlay) {
    lastOverlay = identity;
    void command({ action: 'overlay', ...overlay }).catch(() => {});
  }
  maybeTranslate();
}

function renderSummary(summary: Summary): void {
  renderChapters();
  $('#summary-content').className = '';
  const sections = summary.sections
    .map(
      (section) =>
        `<article class="section-card"><button class="section-time" data-seek="${section.start}">${formatTime(section.start)} ↗</button><h3>${esc(section.title)}</h3><ul>${section.points.map((point) => `<li>${esc(point)}</li>`).join('')}</ul></article>`,
    )
    .join('');
  $('#summary-content').innerHTML =
    `<span class="result-badge">${state.transcript?.coverage === 'complete' ? '全片总结' : '部分内容总结'}</span><h2 class="summary-title">${esc(summary.title)}</h2><p class="summary-overview">${esc(summary.overview)}</p>${sections}<section class="takeaways"><h3>行动与启发</h3><ol>${summary.takeaways.map((point) => `<li>${esc(point)}</li>`).join('')}</ol></section>`;
  $('#summarize-btn').textContent = '重新生成总结';
  $('#summary-disclaimer').textContent = 'AI 可能出错，可点击时间点核对视频原文。';
  syncExportMenu();
}

function updateActions(): void {
  const unavailable =
    !state.transcript?.cues.length ||
    state.loading ||
    Boolean(state.job) ||
    savingTranslationEngine;
  for (const selector of ['#translate-btn', '#summarize-btn'])
    $<HTMLButtonElement>(selector).disabled = unavailable;
  // Searching the library reads no transcript from this tab, so it stays available on a video
  // whose subtitles never loaded.
  $<HTMLButtonElement>('#ask-btn').disabled =
    state.askScope === 'library' ? state.searching || Boolean(state.job) : unavailable;
  document
    .querySelectorAll<HTMLButtonElement>('.scope-chip')
    .forEach((chip) => (chip.disabled = state.searching || Boolean(state.job)));
  const translateButton = $<HTMLButtonElement>('#translate-btn');
  const engine = resolveTranslationEngine(state.settings || { hasApiKey: false, model: '' });
  translateButton.textContent = translator ? '翻译中…' : '翻译全部';
  translateButton.title =
    engine === 'google'
      ? '使用 Chrome 内置的 Google 翻译，无需 API Key；立即翻译整段字幕。'
      : '将整段字幕发送给已配置的 AI 服务翻译；平时会随播放自动逐句翻译。';
  const autoNote = autoTranslateOn() ? '随播放自动翻译' : '已关闭自动翻译，可点「翻译全部」';
  $('#translation-hint').textContent =
    engine === 'google'
      ? `默认字幕 · Google 云端翻译，免 Key、免下载、即时；${autoNote}。`
      : state.settings?.hasApiKey && state.settings.model
        ? `AI 字幕 · 使用你配置的模型和 API 额度，优先翻译播放位置附近；${autoNote}。`
        : 'AI 字幕需要先选择服务商和模型，再填写 Key。';
  const engineBusy = Boolean(state.job) || savingTranslationEngine;
  const googleTab = $<HTMLButtonElement>('#engine-google');
  const aiTab = $<HTMLButtonElement>('#engine-ai');
  googleTab.setAttribute('aria-selected', String(engine === 'google'));
  aiTab.setAttribute('aria-selected', String(engine === 'ai'));
  googleTab.disabled = engineBusy;
  aiTab.disabled = engineBusy;
  $<HTMLButtonElement>('#reload-transcript').disabled = state.loading;
  $<HTMLSelectElement>('#track-select').disabled = state.loading;
  $<HTMLSelectElement>('#target-language').disabled = Boolean(state.job);
  $<HTMLButtonElement>('#prompt-open').disabled = Boolean(state.job);
  $<HTMLButtonElement>('#settings-open').disabled = Boolean(state.job);
  // Translation paints subtitles as it goes, an explanation is a two-second aside, and a question
  // is answered inside the conversation; none of them belongs behind the full-panel waiting card.
  $('#job-status').hidden =
    !state.job ||
    state.jobTask === 'translate' ||
    state.jobTask === 'explain' ||
    state.jobTask === 'ask';
  syncExportMenu();
  publishPreferences();
}

let jobTicker = 0;
let jobStartedAt = 0;
let jobDone = 0;
let jobTotal = 0;

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Deliberately coarse: an estimate from a handful of segments is not worth a precise-looking number. */
function formatRemaining(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${Math.max(10, Math.ceil(seconds / 10) * 10)} 秒`;
  return `${Math.max(1, Math.round(seconds / 60))} 分钟`;
}
/** Past this, the number stops being information and starts being a threat. */
const LONG_WAIT_MS = 55 * 60_000;

/**
 * The only thing worth telling someone who is waiting is how much longer. How the work is divided
 * up, and what it does when a part of it fails, is the code's business, not theirs.
 */
function waitingHint(elapsed: number): string {
  if (jobTotal > 1 && jobDone >= jobTotal) return '正在汇总，马上就好';
  // Sitting on "estimating" for a minute is worse than a rough number, so one finished piece is
  // enough to quote from — rounded hard enough that being a little off does not show.
  if (jobTotal <= 1 || jobDone < 1) return '正在读这段视频…';
  const remaining = (elapsed / jobDone) * (jobTotal - jobDone);
  // "116 分钟" reads as a wrong number rather than as a long wait, and it is not that precise.
  if (remaining >= LONG_WAIT_MS) return '这段视频很长，要 1 小时以上；换更快的模型会明显缩短';
  return `大约还要 ${formatRemaining(remaining)}`;
}

function tickJob(): void {
  const elapsed = Date.now() - jobStartedAt;
  $('#job-elapsed').textContent = `已用 ${formatElapsed(elapsed)}`;
  const pendingTime = document.querySelector('.answer.is-pending .pending-time');
  if (pendingTime) pendingTime.textContent = formatElapsed(elapsed);
  $('#job-hint').textContent = waitingHint(elapsed);
}
function startJobTicker(): void {
  jobStartedAt = Date.now();
  jobDone = 0;
  jobTotal = 0;
  clearInterval(jobTicker);
  tickJob();
  jobTicker = window.setInterval(tickJob, 1000);
}
function stopJobTicker(): void {
  clearInterval(jobTicker);
  jobTicker = 0;
}

function updateProgress(progress: JobProgress): void {
  $('#job-label').textContent = progress.label;
  const pendingLabel = document.querySelector('.answer.is-pending .pending-label');
  if (pendingLabel) pendingLabel.textContent = progress.label;
  const total = Math.max(1, progress.total);
  const completed = Math.min(Math.max(0, progress.completed), total);
  jobTotal = progress.total;
  jobDone = completed;
  // Before the first batch reports back there is no real ratio to show.
  const unknown = progress.total <= 1;
  const ratio = unknown ? 0 : completed / total;
  $('#job-progress').classList.toggle('is-indeterminate', unknown);
  $('#job-progress').setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  $('#job-bar').style.width = unknown ? '' : `${(ratio * 100).toFixed(1)}%`;
  $('#job-step').textContent = unknown ? '' : `${Math.round(ratio * 100)}%`;
}

/**
 * What makes two requests the same piece of work. The video, its subtitles, the language and the
 * prompt decide that — not the model that happened to run it. A summary belongs to the account and
 * the video: changing model, or moving to another machine, must not hide what is already there.
 */
function resultKey(request: AiRequest, settings: PublicSettings, legacy = false): Promise<string> {
  const identity =
    'video' in request
      ? {
          ...request,
          video: {
            id: request.video.id,
            title: request.video.title,
            url: request.video.url,
            duration: request.video.duration,
          },
        }
      : request;
  return cacheKey({
    request: identity,
    // Results kept before this were filed under the model too, and are still found under it once.
    ...(legacy
      ? {
          model: settings.model,
          baseUrl: settings.baseUrl,
          temperature: settings.temperature,
        }
      : {}),
    // 2: outline sections gained density and kind, so version 1 entries render blank badges.
    version: 3,
  });
}

/**
 * What the account already holds for this request, under the current key or the one used before
 * the model stopped being part of it. Anything found under the old key is re-filed under the new
 * one, so the next lookup is direct and the result survives the next model change.
 */
async function findSaved(
  request: AiRequest,
  settings: PublicSettings,
): Promise<AiResult | undefined> {
  const key = await resultKey(request, settings);
  const found = await savedResult(key, request.task);
  if (found) return found;
  const older = await savedResult(await resultKey(request, settings, true), request.task);
  if (older) {
    await writeCache(key, older).catch(() => undefined);
    void cloud.put(key, older, Date.now()).catch(() => undefined);
  }
  return older;
}

/** This machine's cache first; failing that, a copy the account kept from another machine. */
async function savedResult(key: string, task: AiRequest['task']): Promise<AiResult | undefined> {
  const cached = await readCache<AiResult>(key);
  if (cached) return cached;
  try {
    const found = await cloud.get(key);
    const result = found?.value as AiResult | undefined;
    if (result?.task !== task) return undefined;
    await writeCache(key, result).catch(() => undefined);
    return result;
  } catch {
    // Offline, or the session lapsed: generating it again is the fallback either way.
    return undefined;
  }
}

async function run(request: AiRequest, force = false): Promise<AiResult | undefined> {
  const version = state.loadVersion;
  if (state.job || state.loading || savingTranslationEngine) return;
  state.settings = await send<PublicSettings>({ type: 'settings:get' });
  if (state.job || state.loading || savingTranslationEngine || version !== state.loadVersion)
    return;
  const settings = state.settings;
  if (!aiReady(settings)) {
    openSettings();
    notice(
      settings.mode === 'hosted'
        ? '请先登录托管服务，再使用 AI 功能。'
        : '请先配置 API 服务、模型和密钥，再使用 AI 功能。',
    );
    return;
  }
  const controller = new AbortController();
  state.job = controller;
  state.jobTask = request.task;
  updateActions();
  updateProgress({ jobId: '', completed: 0, total: 1, label: '正在准备内容…' });
  startJobTicker();
  notice('');
  $('#google-web-fallback').hidden = true;
  try {
    const key = await resultKey(request, settings);
    const cached = force ? undefined : await findSaved(request, settings);
    if (cached && !controller.signal.aborted && version === state.loadVersion) {
      toast('已使用保存的结果，无需重复处理');
      if (cached.notice) notice(cached.notice);
      return cached;
    }
    if (controller.signal.aborted || version !== state.loadVersion) return;
    const result = await runJob(request, controller.signal, updateProgress);
    if (controller.signal.aborted || version !== state.loadVersion) return;
    const currentSettings = await send<PublicSettings>({ type: 'settings:get' });
    const sameProvider =
      currentSettings.baseUrl === settings.baseUrl &&
      currentSettings.model === settings.model &&
      currentSettings.temperature === settings.temperature;
    if (sameProvider && !controller.signal.aborted && version === state.loadVersion) {
      try {
        await writeCache(key, result);
      } catch {
        toast('结果已生成，但本地缓存空间不足。');
      }
      void cloud.put(key, result, Date.now()).catch(() => undefined);
    }
    if (controller.signal.aborted || version !== state.loadVersion) return undefined;
    // Partial coverage is reported alongside the result instead of discarding it.
    if (result.notice) notice(result.notice);
    return result;
  } catch (error) {
    if (!controller.signal.aborted && version === state.loadVersion) {
      notice(errorMessage(error), true);
    } else toast('已取消处理');
    return;
  } finally {
    if (state.job === controller) {
      state.job = undefined;
      state.jobTask = undefined;
      stopJobTicker();
    }
    updateActions();
  }
}

function aiContext(): { video: VideoInfo; transcript: Transcript; language: string } {
  if (!state.video || !state.transcript) throw new Error('请先读取或导入字幕。');
  return {
    video: state.video,
    transcript: state.transcript,
    language: $<HTMLSelectElement>('#target-language').value,
  };
}

async function summarize(): Promise<void> {
  const context = aiContext();
  const prompt = state.settings?.prompt || PRESETS.learn;
  const result = await run({ task: 'summarize', ...context, prompt }, Boolean(state.summary));
  if (result?.task !== 'summarize') return;
  state.summary = result.summary;
  state.summaryPrompt = prompt;
  renderSummary(result.summary);
}

/** The 章节 content outline is its own lightweight AI task, independent of the full summary. */
async function generateOutline(): Promise<void> {
  const context = aiContext();
  const result = await run({ task: 'outline', ...context }, Boolean(state.outline));
  if (result?.task !== 'outline') return;
  state.outline = result.outline;
  renderChapters();
  showTab('chapters');
  toast('内容目录已生成');
}

// ---- Progressive, playback-driven translation (Trancy-style bilingual subtitles) ----
const AI_CHUNK = 24;
/** Google answers a whole group in one request, so its batches are worth filling. */
const GOOGLE_CHUNK = 100;
const LOOKAHEAD = 60;
const MIN_BATCH = 12;
let translator: AbortController | undefined;
let translateAll = false;
let translationHalted = false;
/** Cues Google still refused after retrying, left out until the viewer asks for everything again. */
const skippedTranslations = new Set<string>();
let cachePersistTimer = 0;
let lastTranslatePaint = 0;

function autoTranslateOn(): boolean {
  return $<HTMLInputElement>('#auto-translate').checked;
}

function currentEngine(): 'google' | 'ai' {
  return resolveTranslationEngine(state.settings || { hasApiKey: false, model: '' });
}

function engineReady(engine: 'google' | 'ai'): boolean {
  return engine === 'google' || aiReady(state.settings);
}

function setTranslateStatus(message: string, error = false): void {
  const el = $('#translate-status');
  el.textContent = message;
  el.hidden = !message;
  el.classList.toggle('error', error);
}

/** Cache key for the whole translation map, scoped so language/engine changes never mix. */
function translationCacheInput(): Record<string, unknown> | undefined {
  const transcript = state.transcript;
  if (!transcript) return undefined;
  const engine = currentEngine();
  return {
    kind: 'progressive-translate',
    videoId: transcript.videoId,
    source: transcript.source,
    count: transcript.cues.length,
    language: $<HTMLSelectElement>('#target-language').value,
    engine,
    model: engine === 'ai' ? state.settings?.model || '' : 'google-chrome',
  };
}

async function primeTranslations(version: number): Promise<void> {
  const input = translationCacheInput();
  if (!input) return;
  try {
    const cached = await readCache<Record<string, string>>(await cacheKey(input));
    const cues = state.transcript?.cues;
    if (!cached || !cues || version !== state.loadVersion) return;
    let added = 0;
    for (const cue of cues) {
      if (typeof cached[cue.id] === 'string' && !state.translations[cue.id]) {
        state.translations[cue.id] = cached[cue.id]!;
        added += 1;
      }
    }
    if (added) {
      renderTranscript();
      lastOverlay = '';
      updatePlayback();
    }
  } catch {
    /* Cached progress is best-effort and never blocks fresh translation. */
  }
}

function persistTranslations(): void {
  clearTimeout(cachePersistTimer);
  cachePersistTimer = window.setTimeout(() => {
    const input = translationCacheInput();
    const snapshot = { ...state.translations };
    if (!input || !Object.keys(snapshot).length) return;
    void cacheKey(input)
      .then((key) => writeCache(key, snapshot))
      .catch(() => undefined);
  }, 1500);
}

function needsTranslation(cue: Cue | undefined): cue is Cue {
  return Boolean(cue && !state.translations[cue.id] && !skippedTranslations.has(cue.id));
}

function batchSize(): number {
  return currentEngine() === 'google' ? GOOGLE_CHUNK : AI_CHUNK;
}

function collectUntranslated(cues: Cue[], from: number, to: number): Cue[] {
  const out: Cue[] = [];
  const end = Math.min(cues.length, to);
  const limit = batchSize();
  for (let index = Math.max(0, from); index < end && out.length < limit; index += 1) {
    const cue = cues[index];
    if (needsTranslation(cue)) out.push(cue);
  }
  return out;
}

/** Prefer the window just ahead of the playhead; only sweep the whole video on demand. */
function nextBatch(): Cue[] | undefined {
  const cues = state.transcript?.cues;
  if (!cues?.length) return undefined;
  const active = Math.max(0, state.activeCue);
  const span = Math.max(LOOKAHEAD, batchSize());
  const ahead = collectUntranslated(cues, active, active + span);
  if (ahead.length) return ahead;
  const behind = collectUntranslated(cues, active - 40, active);
  if (behind.length) return behind;
  // Free cloud Google fills the whole video (like Trancy); paid AI stays near the playhead.
  if (!translateAll && currentEngine() !== 'google') return undefined;
  const first = cues.findIndex((cue) => needsTranslation(cue));
  return first < 0 ? undefined : collectUntranslated(cues, first, first + span);
}

function untranslatedInWindow(): number {
  const cues = state.transcript?.cues;
  if (!cues?.length) return 0;
  const active = Math.max(0, state.activeCue);
  let count = 0;
  const end = Math.min(cues.length, active + LOOKAHEAD);
  for (let index = active; index < end; index += 1) {
    if (needsTranslation(cues[index])) count += 1;
  }
  return count;
}

function mergeTranslations(map: Record<string, string>, force = false): void {
  Object.assign(state.translations, map);
  const now = performance.now();
  if (force || now - lastTranslatePaint >= 120) {
    lastTranslatePaint = now;
    renderTranscript();
    lastOverlay = '';
    updatePlayback();
  }
  persistTranslations();
}

function maybeTranslate(): void {
  // Mid-switch the settings still name the engine being left, and a run started now (a cancelled
  // run restarting, a playback tick) would keep translating with it after the switch.
  if (translator || !state.transcript || translationHalted || savingTranslationEngine) return;
  if (!autoTranslateOn() && !translateAll) return;
  if (!engineReady(currentEngine())) return;
  const activeMissing = needsTranslation(state.transcript.cues[state.activeCue]);
  if (!translateAll && !activeMissing && untranslatedInWindow() < MIN_BATCH) return;
  // runTranslator() calls back here from its finally block. Starting a run with nothing to do
  // would return through that block synchronously and re-enter, overflowing the stack.
  if (!nextBatch()) return;
  void runTranslator();
}

async function translateBatchAi(cues: Cue[], signal: AbortSignal, version: number): Promise<void> {
  const transcript = state.transcript!;
  const result = await runJob(
    {
      task: 'translate',
      transcript: {
        videoId: transcript.videoId,
        language: transcript.language,
        source: transcript.source,
        coverage: 'unknown',
        cues,
      },
      language: $<HTMLSelectElement>('#target-language').value,
    },
    signal,
    () => undefined,
  );
  if (signal.aborted || version !== state.loadVersion || result.task !== 'translate') return;
  mergeTranslations(result.translations, true);
}

async function runTranslator(): Promise<void> {
  if (translator) return;
  const controller = new AbortController();
  translator = controller;
  const version = state.loadVersion;
  const engine = currentEngine();
  updateActions();
  try {
    // Both engines translate progressively around the playhead (Trancy-style):
    // Google uses the instant cloud endpoint, AI uses the configured model in small batches.
    const total = state.transcript!.cues.length;
    const label = engine === 'ai' ? 'AI 翻译中' : 'Google 翻译中';
    while (
      !controller.signal.aborted &&
      version === state.loadVersion &&
      (autoTranslateOn() || translateAll) &&
      engineReady(engine)
    ) {
      const batch = nextBatch();
      // 翻译全部 is a one-shot sweep: leaving the flag set keeps every later idle check
      // believing there is work to do.
      if (!batch) {
        translateAll = false;
        break;
      }
      setTranslateStatus(`${label} · ${Object.keys(state.translations).length} / ${total} 句`);
      if (engine === 'ai') {
        await translateBatchAi(batch, controller.signal, version);
      } else {
        const { translations, failed } = await translateCuesCloud(
          batch,
          $<HTMLSelectElement>('#target-language').value,
          controller.signal,
        );
        if (controller.signal.aborted || version !== state.loadVersion) return;
        // A sentence Google keeps refusing must neither stop the rest of the video nor be asked
        // for again on every pass.
        for (const id of failed) skippedTranslations.add(id);
        mergeTranslations(translations, true);
      }
    }
    if (version === state.loadVersion && !controller.signal.aborted) setTranslateStatus('');
  } catch (error) {
    if (!controller.signal.aborted && version === state.loadVersion) {
      // Stop retrying on failure so a broken model/network can't hammer the API in a loop.
      translationHalted = true;
      const message = errorMessage(error);
      notice(engine === 'ai' ? `${message}（可切换「默认字幕」用 Google 翻译）` : message, true);
      setTranslateStatus('');
      if (engine === 'google') $('#google-web-fallback').hidden = false;
    }
  } finally {
    if (translator === controller) translator = undefined;
    if (version === state.loadVersion) {
      updateActions();
      // The playhead may have advanced into untranslated territory during the batch.
      if (!translationHalted) maybeTranslate();
    }
  }
}

function cancelTranslator(): void {
  translator?.abort();
  translator = undefined;
  translateAll = false;
  translationHalted = false;
  skippedTranslations.clear();
  clearTimeout(cachePersistTimer);
  setTranslateStatus('');
}

/** The manual button forces the entire remaining video to translate now. */
function forceTranslateAll(): void {
  if (!state.transcript?.cues.length) {
    notice('请先读取或导入字幕。', true);
    return;
  }
  if (currentEngine() === 'ai' && !engineReady('ai')) {
    openSettings();
    notice('AI 翻译需要先选择服务商和模型，再填写 Key。');
    return;
  }
  translateAll = true;
  translationHalted = false;
  // Asking for everything is also asking to try the sentences that failed before.
  skippedTranslations.clear();
  setTranslateStatus('');
  if (!translator) void runTranslator();
  else updateActions();
}

/** Trancy-style engine switch: "默认字幕" = Google (instant), "AI 字幕" = configured model. */
async function setEngine(engine: 'google' | 'ai'): Promise<void> {
  if (currentEngine() === engine && !translationHalted) return;
  if (engine === 'ai' && !engineReady('ai')) {
    openSettings();
    notice('AI 翻译需要先选择服务商和模型，再填写 Key。');
    return;
  }
  savingTranslationEngine = true;
  cancelTranslator();
  updateActions();
  try {
    state.settings = await send<PublicSettings>({
      type: 'settings:save',
      settings: { translationEngine: engine },
    });
    state.translations = {};
    $('#google-web-fallback').hidden = true;
    renderTranscript();
    updatePlayback();
  } finally {
    savingTranslationEngine = false;
    updateActions();
    const version = state.loadVersion;
    void primeTranslations(version).finally(() => {
      if (version === state.loadVersion) maybeTranslate();
    });
  }
}

/**
 * Only offered when the server says it has an embedding provider. Hiding it beats showing a
 * control that answers with a configuration error.
 */
async function refreshLibrarySearch(): Promise<void> {
  const settings = state.settings;
  const eligible = settings?.mode === 'hosted' && settings.hasSession;
  state.librarySearch = false;
  if (eligible) {
    try {
      const status = await send<{ features?: { librarySearch?: boolean } }>({
        type: 'account:status',
      });
      state.librarySearch = Boolean(status.features?.librarySearch);
    } catch {
      // Offline, or an older server with no feature list: the surface stays hidden either way.
      state.librarySearch = false;
    }
  }
  if (!state.librarySearch) state.askScope = 'video';
  renderAskScope();
}

function renderAskScope(): void {
  $('#ask-scope').hidden = !state.librarySearch;
  document.querySelectorAll<HTMLButtonElement>('.scope-chip').forEach((chip) => {
    chip.setAttribute('aria-pressed', String(chip.dataset.scope === state.askScope));
  });
  $<HTMLTextAreaElement>('#question').placeholder =
    state.askScope === 'library' ? '在你看过的所有视频里搜索…' : '关于这段视频，你想了解什么？';
}

async function searchLibrary(query: string): Promise<void> {
  query = query.trim();
  if (!query || state.searching || state.job) return;
  state.searching = true;
  updateActions();
  try {
    const matches = await send<LibraryMatch[]>({ type: 'library:search', query });
    document.querySelector('.chat-welcome')?.remove();
    appendLibraryResults(query, matches);
    $<HTMLTextAreaElement>('#question').value = '';
  } finally {
    state.searching = false;
    updateActions();
  }
}

function appendLibraryResults(query: string, matches: LibraryMatch[]): void {
  const item = document.createElement('section');
  const asked = document.createElement('div');
  asked.className = 'user-message';
  asked.textContent = query;
  const answer = document.createElement('div');
  answer.className = 'answer';
  const label = document.createElement('span');
  label.className = 'answer-label';
  label.textContent = '资料库检索';
  answer.append(label);
  if (!matches.length) {
    const empty = document.createElement('p');
    empty.textContent = '资料库里没有相关内容。只有用托管模式处理过的视频会被收录。';
    answer.append(empty);
  }
  for (const match of matches) {
    const url = watchUrl(match.videoId, match.start);
    const current = match.videoId === state.video?.id;
    const card = document.createElement(current || !url ? 'button' : 'a');
    card.className = 'library-result';
    if (card instanceof HTMLAnchorElement && url) {
      card.href = url;
      card.target = '_blank';
      card.rel = 'noopener noreferrer';
    } else if (card instanceof HTMLButtonElement) {
      card.type = 'button';
      // Same video: jump in place rather than opening a second copy of it.
      if (current) card.addEventListener('click', () => void seek(match.start));
      else card.disabled = true;
    }
    const title = document.createElement('h4');
    title.textContent = current ? '本视频' : match.title || '未命名视频';
    const text = document.createElement('p');
    text.textContent = match.text;
    const where = document.createElement('span');
    where.className = 'library-where';
    where.textContent = [match.author, `${formatTime(match.start)} ↗`].filter(Boolean).join(' · ');
    card.append(title, text, where);
    answer.append(card);
  }
  item.append(asked, answer);
  $('#messages').append(item);
  $('#messages').scrollTo({ top: $('#messages').scrollHeight, behavior: 'smooth' });
}

/** Earlier exchanges sent along with a question, so a follow-up can refer back to them. */
const HISTORY_TURNS = 4;
/** The mascot's head gives answers a face; while a reply is pending it tilts and glances about. */
const ANSWER_HEAD = `<div class="answer-head"><span class="ai-avatar" aria-hidden="true"><svg viewBox="10 4 28 28"><g class="avatar-head"><path class="cat-fill" d="M15 14.5 16.2 6l7.2 5.2z"/><path class="cat-fill" d="M33 14.5 31.8 6l-7.2 5.2z"/><circle class="cat-fill" cx="24" cy="19.2" r="9.6"/><g class="avatar-eyes"><circle cx="20.4" cy="18.6" r="1.5"/><circle cx="27.6" cy="18.6" r="1.5"/></g><path class="cat-nose" d="M24 22.4 22.5 23.7h3z"/><path class="cat-whiskers" d="M11.8 17.4h4.2M11.8 21h4.2M36.2 17.4H32M36.2 21H32"/></g></svg></span><span class="answer-label">旁听 AI</span></div>`;

async function ask(question: string): Promise<void> {
  question = question.trim();
  if (!question || state.job) return;
  const history = chatHistory();
  const request: AiRequest = {
    task: 'ask',
    ...aiContext(),
    question,
    ...(history.length ? { history } : {}),
  };
  const messages = $('#messages');
  const welcome = messages.querySelector('.chat-welcome');
  welcome?.remove();
  // As in any conversation, the question and a reply visibly being worked on appear at once.
  const item = appendExchange(question);
  const input = $<HTMLTextAreaElement>('#question');
  if (input.value.trim() === question) input.value = '';
  const result = await run(request);
  if (result?.task === 'ask') {
    fillAnswer(item, result.answer);
    return;
  }
  // A new video reset the conversation while this waited: nothing of it is on screen any more.
  if (!item.isConnected) return;
  // Failed, cancelled or never started: take the exchange back and return the question to the box.
  item.remove();
  if (welcome && !messages.querySelector('section')) messages.prepend(welcome);
  if (!input.value.trim()) input.value = question;
}

function appendExchange(question: string): HTMLElement {
  const item = document.createElement('section');
  item.innerHTML = `<div class="user-message">${esc(question)}</div><div class="answer is-pending" aria-busy="true">${ANSWER_HEAD}<div class="pending"><span class="pending-label">正在准备内容…</span><span class="pending-time" aria-hidden="true"></span><button type="button" class="text-button stop-answer">停止回答</button></div></div>`;
  item.querySelector('.stop-answer')?.addEventListener('click', () => state.job?.abort());
  $('#messages').append(item);
  $('#messages').scrollTo({ top: $('#messages').scrollHeight, behavior: 'smooth' });
  return item;
}

function fillAnswer(item: HTMLElement, answer: Answer): void {
  item.classList.add('exchange');
  const reply = item.querySelector('.answer');
  if (reply)
    reply.outerHTML = `<div class="answer">${ANSWER_HEAD}<p>${esc(answer.text)}</p>${answer.citations.map((citation) => `<button class="citation" data-seek="${citation.start}">${formatTime(citation.start)} · ${esc(citation.label)} ↗</button>`).join('')}</div>`;
  $('#messages').scrollTo({ top: $('#messages').scrollHeight, behavior: 'smooth' });
}

/** The answered exchanges on screen, oldest first; answers are trimmed to keep the call small. */
function chatHistory(): ChatTurn[] {
  return [...document.querySelectorAll('#messages .exchange')]
    .slice(-HISTORY_TURNS)
    .map((item) => ({
      question: item.querySelector('.user-message')?.textContent ?? '',
      answer: (item.querySelector('.answer p')?.textContent ?? '').slice(0, 2000),
    }));
}

function exportDocument(): ExportDocument {
  if (!state.summary || !state.video) throw new Error('请先生成视频总结。');
  return {
    video: state.video,
    summary: state.summary,
    prompt: state.summaryPrompt,
    createdAt: new Date().toISOString(),
  };
}

/** Stands on its own: every clip keeps its timestamp, its source line and what you wrote. */
function clipsMarkdown(): string {
  const video = state.video;
  const lines = [`# ${video?.title ?? '视频'} · 笔记`, ''];
  if (video?.url) lines.push(`来源：${video.url}`, '');
  for (const clip of state.clips) {
    lines.push(`## ${formatTime(clip.start)}`, '', clip.text, '');
    if (clip.translation) lines.push(`> ${clip.translation}`, '');
    if (clip.comment.trim()) lines.push(clip.comment.trim(), '');
  }
  return lines.join('\n');
}

/** The bundled subset font is ~1.5 MB, so it is fetched only when a PDF is actually exported. */
async function pdfFont(): Promise<Uint8Array> {
  const response = await fetch(chrome.runtime.getURL('fonts/NotoSansSC-Subset.otf'));
  if (!response.ok) throw new Error('中文字体加载失败，无法生成 PDF。');
  return new Uint8Array(await response.arrayBuffer());
}

/** Subtitles export as soon as there are any; the note formats need a summary. */
function syncExportMenu(): void {
  const cues = Boolean(state.transcript?.cues.length);
  $<HTMLButtonElement>('#export-open').disabled = !cues && !state.summary;
  $<HTMLButtonElement>('#export-subtitles').disabled = !cues || exportingSubtitles;
  document.querySelectorAll<HTMLButtonElement>('[data-export]').forEach((item) => {
    item.disabled = item.dataset.export !== 'clips' && !state.summary;
  });
}

function subtitleChoice(name: 'subtitle-format' | 'subtitle-content'): string {
  return document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value ?? '';
}

function untranslatedCount(): number {
  return state.transcript?.cues.filter((cue) => !state.translations[cue.id]).length ?? 0;
}

/** Says before the click what exporting translations involves, so the wait is no surprise. */
function describeSubtitleExport(): void {
  if (exportingSubtitles) return;
  const missing = subtitleChoice('subtitle-content') === 'original' ? 0 : untranslatedCount();
  const status = $('#export-subtitles-status');
  status.textContent = missing
    ? `还有 ${missing} 句没有译文，导出时会先用${currentEngine() === 'ai' ? ' AI ' : ' Google '}翻译补齐。`
    : '';
  status.hidden = !missing;
}

async function exportSubtitles(): Promise<void> {
  const { transcript, video } = state;
  if (!transcript?.cues.length || !video || exportingSubtitles) return;
  const content = subtitleChoice('subtitle-content') as DisplayMode;
  const format = subtitleChoice('subtitle-format');
  const status = $('#export-subtitles-status');
  exportingSubtitles = true;
  syncExportMenu();
  try {
    if (content !== 'original' && untranslatedCount()) {
      if (!engineReady(currentEngine())) {
        // Opens settings and says what is missing; there is no translation to wait for.
        forceTranslateAll();
        return;
      }
      forceTranslateAll();
      // 翻译全部 runs on the panel's own translator: wait out its sweep, however it ends.
      while (translator && state.transcript === transcript) {
        const total = transcript.cues.length;
        status.hidden = false;
        status.textContent = `正在翻译 ${total - untranslatedCount()} / ${total} 句，完成后自动下载…`;
        await new Promise((resolve) => window.setTimeout(resolve, 400));
      }
      if (state.transcript !== transcript) return;
    }
    const entries = transcript.cues.map((cue) => ({
      start: cue.start,
      end: cue.end,
      lines: subtitleLines(cue.text, state.translations[cue.id], content),
    }));
    const name = `${video.title} 字幕`;
    if (format === 'pdf') {
      const [{ buildSubtitlePdf }, font] = await Promise.all([import('../core/pdf'), pdfFont()]);
      const pdf = await buildSubtitlePdf(video, entries, { font });
      downloadFile(`${name}.pdf`, pdf, 'application/pdf');
    } else if (format === 'md') {
      const markdown = buildSubtitleMarkdown(video, entries);
      downloadFile(`${name}.md`, markdown, 'text/markdown;charset=utf-8');
    } else downloadFile(`${name}.srt`, buildSrt(entries), 'application/x-subrip;charset=utf-8');
    const missing = content === 'original' ? 0 : untranslatedCount();
    if (missing) notice(`有 ${missing} 句没能翻译，导出的字幕里这些句子只有原文。`, true);
    closeExport();
  } finally {
    exportingSubtitles = false;
    syncExportMenu();
    describeSubtitleExport();
  }
}

async function exportNotes(format: string): Promise<void> {
  closeExport();
  if (format === 'clips') {
    if (!state.clips.length) throw new Error('还没有任何笔记。');
    downloadFile(
      `${state.video?.title ?? '视频'} 笔记.md`,
      clipsMarkdown(),
      'text/markdown;charset=utf-8',
    );
    return;
  }
  const doc = exportDocument();
  if (format === 'pdf') {
    const [{ buildPdf }, font] = await Promise.all([import('../core/pdf'), pdfFont()]);
    downloadFile(`${doc.summary.title}.pdf`, await buildPdf(doc, { font }), 'application/pdf');
  } else if (format === 'print') {
    await send({
      type: 'export:print',
      video: doc.video,
      summary: doc.summary,
      prompt: doc.prompt,
    });
  } else if (format === 'xmind') {
    downloadFile(`${doc.summary.title}.xmind`, buildXMind(doc), 'application/vnd.xmind.workbook');
  } else {
    downloadFile(`${doc.summary.title}.md`, buildMarkdown(doc), 'text/markdown;charset=utf-8');
  }
}

function closeExport(): void {
  $('#export-menu').hidden = true;
  $('#export-open').setAttribute('aria-expanded', 'false');
}

function openSettings(): void {
  const settings = state.settings;
  if (!settings || state.job) return;
  connectionFormVersion++;
  const provider = $<HTMLSelectElement>('#provider');
  provider.replaceChildren(...PROVIDERS.map((item) => new Option(item.label, item.id)));
  if (settings.provider === 'custom') {
    const legacy = new Option('旧配置 · 请选择服务商后更新', 'custom');
    legacy.disabled = true;
    provider.add(legacy, 0);
  }
  provider.value = settings.provider;
  renderProviderModels(settings.model);
  $<HTMLInputElement>('#api-key').value = '';
  $<HTMLInputElement>('#api-key').placeholder = settings.hasApiKey
    ? '已保存密钥；留空保持不变'
    : '输入 API Key';
  $<HTMLInputElement>('#remember-key').checked = settings.rememberKey;
  $('#key-status').textContent = settings.hasApiKey
    ? '密钥已配置，仅 AI 后台使用。更换服务商后需填写对应的 Key。'
    : '密钥不会显示在视频页面。';
  $('#settings-error').hidden = true;
  renderSettingsMode(settings.mode);
  $<HTMLDialogElement>('#settings-dialog').showModal();
}

/**
 * Hidden required controls block form submission and cannot be focused to report the error, so
 * the inactive half is disabled as well as hidden.
 */
function renderSettingsMode(mode: RunMode): void {
  const hosted = mode === 'hosted';
  // Hidden while everyone brings their own key; the markup and the flow stay for its return.
  $('#mode-toggle').hidden = !SUBSCRIPTION_ENABLED;
  $('#mode-byok').setAttribute('aria-selected', String(!hosted));
  $('#mode-hosted').setAttribute('aria-selected', String(hosted));
  const hostedFields = $<HTMLFieldSetElement>('#hosted-fields');
  const byokFields = $<HTMLFieldSetElement>('#byok-fields');
  hostedFields.hidden = !hosted;
  hostedFields.disabled = !hosted;
  byokFields.hidden = hosted;
  byokFields.disabled = hosted;
  $('#byok-actions').hidden = hosted;
  $('#account-email').textContent = state.settings?.accountEmail || '';
  $('#account-summary').textContent = '点「刷新状态」查看订阅与今日用量。';
  $('#mode-hint').textContent = hosted
    ? 'Google 账号一键登录，不用申请和填写 API Key，全部 AI 功能开箱即用，另享跨视频「我的资料库」。目前内测中，仅限受邀用户。'
    : '扩展免费，按你在服务商那里的实际用量付费；字幕和提问只发给你选择的服务商。';
  updateConnectionTest();
}

async function switchMode(mode: RunMode): Promise<void> {
  if (state.job) throw new Error('请先等待当前任务完成，或取消任务后再切换运行方式。');
  if (state.settings?.mode === mode) return;
  if (mode === 'hosted' && state.settings) {
    // Requesting host access needs the user gesture this click already provides.
    const origin = getOriginPattern(state.settings.serverUrl);
    if (!(await chrome.permissions.request({ origins: [origin] })))
      throw new Error('未获得访问托管服务的授权，无法切换。');
  }
  state.settings = await send<PublicSettings>({ type: 'settings:save', settings: { mode } });
  renderSettingsMode(mode);
  updateActions();
  void refreshLibrarySearch();
}

let signingIn = false;

/**
 * Google is the only way in. The token never touches this page: the worker runs the flow and
 * hands back only the resulting session, so a compromised panel has nothing to steal.
 */
async function signIn(): Promise<void> {
  if (signingIn || !state.settings) return;
  signingIn = true;
  const button = $<HTMLButtonElement>('#sign-in');
  button.disabled = true;
  $('#sign-in-error').hidden = true;
  try {
    // Asked inside the click, the only moment Chrome allows it.
    const origin = getOriginPattern(state.settings.serverUrl);
    if (!(await chrome.permissions.request({ origins: [origin] })))
      throw new Error('需要允许访问旁听服务，才能把笔记保存到你的账号。');
    await send<PublicSettings>({ type: 'account:signIn' });
    // Starting over is simpler than finishing half an initialisation, and it guarantees nothing
    // from before sign-in, or from another account, is still on screen.
    location.reload();
  } catch (error) {
    $('#sign-in-error').textContent = errorMessage(error);
    $('#sign-in-error').hidden = false;
    signingIn = false;
    button.disabled = false;
  }
}

/** Hosted mode has no key or model of its own; a signed-in session is what makes it usable. */
function aiReady(settings: PublicSettings | undefined): boolean {
  if (!settings) return false;
  return settings.mode === 'hosted'
    ? settings.hasSession
    : Boolean(settings.hasApiKey && settings.model.trim());
}

function selectedProvider() {
  return getProvider($<HTMLSelectElement>('#provider').value as AiProvider);
}

function renderProviderModels(savedModel?: string): void {
  const provider = selectedProvider();
  const model = $<HTMLSelectElement>('#model');
  model.replaceChildren(
    ...(provider?.models || []).map((item) => new Option(item.label + ' · ' + item.id, item.id)),
  );
  if (provider)
    model.value = provider.models.some((item) => item.id === savedModel)
      ? savedModel!
      : provider.defaultModel;
  else model.add(new Option(savedModel || '请先选择服务商', savedModel || ''));
  model.disabled = !provider;
  $<HTMLButtonElement>('#save-settings').disabled = !provider;
  $('#provider-hint').textContent = provider
    ? (provider.note ?? '直连官方服务，地址已内置。模型可用性取决于你的账户权限。')
    : '原有配置已保留。请选择服务商与模型，并填写对应 Key 后更新。';
}

function updateConnectionTest(): void {
  const saved = state.settings;
  if (saved?.mode === 'hosted') {
    $<HTMLButtonElement>('#test-connection').disabled = testingConnection || !saved.hasSession;
    $('#test-connection').textContent = testingConnection
      ? '正在检查账号…'
      : saved.hasSession
        ? '检查账号状态'
        : '登录后可检查';
    return;
  }
  const unchanged =
    saved?.provider === $<HTMLSelectElement>('#provider').value &&
    saved?.model === $<HTMLSelectElement>('#model').value &&
    !$<HTMLInputElement>('#api-key').value;
  $<HTMLButtonElement>('#test-connection').disabled =
    testingConnection || !saved?.hasApiKey || !unchanged;
  $('#test-connection').textContent = testingConnection
    ? '正在连接已保存的服务…'
    : unchanged
      ? '测试已保存的连接'
      : '保存后测试此模型';
}

async function saveSettings(): Promise<void> {
  connectionFormVersion++;
  const button = $<HTMLButtonElement>('#save-settings');
  button.disabled = true;
  try {
    if (state.job) throw new Error('请先等待当前任务完成，或取消任务后再修改 AI 设置。');
    const provider = selectedProvider();
    if (!provider) throw new Error('请先选择服务商。');
    const baseUrl = provider.baseUrl;
    const model = $<HTMLSelectElement>('#model').value;
    if (!provider.models.some((item) => item.id === model))
      throw new Error('请选择此服务商的模型。');
    const apiKey = $<HTMLInputElement>('#api-key').value.trim();
    // Request is directly descended from the submit gesture, before any network work.
    const allowed = await chrome.permissions.request({ origins: [getOriginPattern(baseUrl)] });
    if (!allowed) throw new Error('未获得 API 服务访问权限，设置尚未保存。');
    state.settings = await send<PublicSettings>({
      type: 'settings:save',
      settings: {
        provider: provider.id,
        model,
        ...(apiKey ? { apiKey } : {}),
        rememberKey: $<HTMLInputElement>('#remember-key').checked,
      },
    });
    $<HTMLInputElement>('#api-key').value = '';
    $<HTMLDialogElement>('#settings-dialog').close();
    resetResults();
    updateActions();
    translationHalted = false;
    maybeTranslate();
    toast(
      state.settings.hasApiKey ? '设置已保存，可开始使用 AI' : '偏好已保存，填写 Key 后可使用 AI',
    );
  } catch (error) {
    $('#settings-error').hidden = false;
    $('#settings-error').textContent = errorMessage(error);
  } finally {
    button.disabled = !selectedProvider();
  }
}

async function importTranscript(): Promise<void> {
  const input = $<HTMLInputElement>('#subtitle-file');
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (!state.video) throw new Error('请先在 YouTube 打开一个视频，再导入对应字幕。');
  if (file.size > 8 * 1024 * 1024) throw new Error('字幕文件不能超过 8 MB。');
  const videoId = state.video.id;
  const version = ++state.loadVersion;
  state.job?.abort();
  state.loading = true;
  updateActions();
  try {
    const cues = parseTranscript(
      await file.text(),
      file.name.toLowerCase().endsWith('.vtt') ? 'vtt' : 'srt',
    );
    if (version !== state.loadVersion || state.video?.id !== videoId) return;
    installTranscript({ videoId, language: 'auto', source: 'import', coverage: 'unknown', cues });
    toast(`已导入 ${cues.length} 句字幕`);
  } finally {
    if (version === state.loadVersion) state.loading = false;
    updateActions();
  }
}

function bindEvents(): void {
  on('#provider', 'change', () => {
    renderProviderModels();
    $<HTMLInputElement>('#api-key').value = '';
    $<HTMLInputElement>('#api-key').placeholder =
      state.settings?.provider === selectedProvider()?.id && state.settings?.hasApiKey
        ? '已保存密钥；留空保持不变'
        : '输入此服务商的 API Key';
    $('#key-status').textContent =
      state.settings?.provider === selectedProvider()?.id
        ? '密钥仅供此服务商使用。'
        : '请填写此服务商的 Key；保存时会清除上一家服务的密钥。';
    connectionFormChanged();
  });
  on('#model', 'change', connectionFormChanged);
  on('#api-key', 'input', connectionFormChanged);
  document.body.addEventListener('click', (event) => {
    const target = (event.target as Element).closest<HTMLElement>('button');
    if (!target) return;
    const data = target.dataset;
    if (data.tab) showTab(data.tab as Tab);
    if (data.goto) showTab(data.goto as Tab);
    if (data.close) $<HTMLDialogElement>(`#${data.close}`).close();
    if (data.seek !== undefined) {
      // A click that finished a text selection inside this element was a drag to select, not a
      // request to jump; seeking there would fight the viewer trying to copy a line.
      if (selectionInside(target)) return;
      honourSeekUntil = Date.now() + SEEK_GRACE_MS;
      void seek(Number(data.seek)).catch((error: unknown) => notice(errorMessage(error), true));
    }
    if (data.copyCue !== undefined) {
      void copyCue(Number(data.copyCue)).catch((error: unknown) =>
        notice(errorMessage(error), true),
      );
      return;
    }
    if ('clipSelection' in data)
      void clipSelection().catch((error: unknown) => notice(errorMessage(error), true));
    if (data.note) {
      void openNote(data.note).catch((error: unknown) => notice(errorMessage(error), true));
      return;
    }
    if (data.unclip) {
      if (explainSubject === undefined) closeExplainPanel();
      void removeClip(data.unclip).catch((error: unknown) => notice(errorMessage(error), true));
    }
    if ('explain' in data) {
      void explainSelection().catch((error: unknown) => {
        hideExplain();
        notice(errorMessage(error), true);
      });
    }
    if (data.speak) {
      speak(data.speak, speechLang());
      return;
    }
    if (data.explainCue !== undefined) {
      const index = Number(data.explainCue);
      const cue = state.transcript?.cues[index];
      if (cue)
        void explainInPanel(cue.text, index, 'sentence').catch((error: unknown) =>
          notice(errorMessage(error), true),
        );
      return;
    }
    if (data.cue !== undefined && (window.getSelection()?.isCollapsed ?? true)) {
      honourSeekUntil = Date.now() + SEEK_GRACE_MS;
      const cue = state.transcript?.cues[Number(data.cue)];
      if (cue) void seek(cue.start).catch((error: unknown) => notice(errorMessage(error), true));
    }
    if (data.preset)
      $<HTMLTextAreaElement>('#prompt-text').value = PRESETS[data.preset as keyof typeof PRESETS];
    if (data.question) {
      showTab('chat');
      void ask(data.question).catch((error: unknown) => notice(errorMessage(error), true));
    }
    if (data.guide !== undefined) toggleGuide(Number(data.guide));
    if ('generateGlossary' in data) {
      showTab('glossary');
      void generateGlossary().catch((error: unknown) => notice(errorMessage(error), true));
    }
    if ('generateGuide' in data) {
      showTab('guide');
      void generateGuide().catch((error: unknown) => notice(errorMessage(error), true));
    }
    if ('generateOutline' in data) {
      showTab('chapters');
      void generateOutline().catch((error: unknown) => notice(errorMessage(error), true));
    }
    if (data.export)
      void exportNotes(data.export).catch((error: unknown) => notice(errorMessage(error), true));
    if ('import' in data) $<HTMLInputElement>('#subtitle-file').click();
    if ('retryTranscript' in data) void loadTranscript();
    if ('searchClear' in data) {
      state.query = '';
      $<HTMLInputElement>('#search').value = '';
      state.windowStart = 0;
      renderTranscript();
    }
    if (data.page) {
      setFollow(false);
      state.windowStart = Math.max(0, state.windowStart + (data.page === 'next' ? 80 : -80));
      renderTranscript();
      $('#transcript-list').scrollTop = 0;
    }
    if (!target.closest('.export-wrap')) closeExport();
  });

  on('#reload-transcript', 'click', loadTranscript);
  on('#track-select', 'change', loadTranscript);
  on('#import-open', 'click', () => $<HTMLInputElement>('#subtitle-file').click());
  on('#subtitle-file', 'change', importTranscript);
  on('#translate-btn', 'click', () => forceTranslateAll());
  on('#auto-translate', 'change', async () => {
    const autoTranslate = $<HTMLInputElement>('#auto-translate').checked;
    if (!autoTranslate) cancelTranslator();
    state.settings = await send<PublicSettings>({
      type: 'settings:save',
      settings: { autoTranslate },
    });
    updateActions();
    if (autoTranslate) {
      translationHalted = false;
      maybeTranslate();
    }
  });
  // A pointer release is when a selection is finished; selectionchange fires mid-drag.
  $('#transcript-list').addEventListener('mouseup', () => window.setTimeout(offerExplain, 0));
  $('#transcript-list').addEventListener('scroll', hideExplain, { passive: true });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if ($('#explain-panel').classList.contains('is-open')) closeExplainPanel();
    hideExplain();
  });
  on('#explain-close', 'click', closeExplainPanel);
  on('#explain-panel-clip', 'click', () =>
    clipExplained().catch((error: unknown) => notice(errorMessage(error), true)),
  );
  on('#notes-scope-video', 'click', () => setNotesScope('video'));
  on('#notes-scope-all', 'click', () => setNotesScope('all'));
  // Capture: a word beats the row's own seek, which is still what the rest of the row does.
  $('#transcript-list').addEventListener(
    'click',
    (event) => {
      const original = (event.target as Element | null)?.closest<HTMLElement>('.cue .original');
      const row = original?.closest<HTMLElement>('[data-cue]');
      if (!row || !(window.getSelection()?.isCollapsed ?? true)) return;
      const word = wordAtPoint(event.clientX, event.clientY);
      if (!word) return;
      event.stopPropagation();
      event.preventDefault();
      void explainInPanel(word, Number(row.dataset.cue), 'word').catch((error: unknown) =>
        notice(errorMessage(error), true),
      );
    },
    true,
  );
  document.addEventListener('mousedown', (event) => {
    const target = event.target as Element | null;
    if (!target?.closest('#explain-bubble')) hideExplain();
  });
  on('#clip-current', 'click', () => clipActiveCue());
  on('#notes-clear', 'click', async () => {
    state.clips = [];
    renderClips();
    await persistClips();
    toast('笔记已清空');
  });
  $('#explain-panel-body').addEventListener('input', (event) => {
    const target = event.target as HTMLTextAreaElement;
    const ref = target.dataset.comment;
    if (!ref) return;
    const comment = target.value;
    // Typing should not write on every keystroke; the save rides the next idle callback.
    clearTimeout(commentSaveTimer);
    commentSaveTimer = window.setTimeout(() => {
      void editComment(ref, comment).catch((error: unknown) => notice(errorMessage(error), true));
    }, 600);
  });
  on('#skip-filler', 'click', () => {
    state.skipFiller = !state.skipFiller;
    $('#skip-filler').setAttribute('aria-pressed', String(state.skipFiller));
    toast(state.skipFiller ? '只看干货：低密度段落会自动跳过' : '已恢复完整播放');
  });
  on('#engine-google', 'click', () => setEngine('google'));
  on('#engine-ai', 'click', () => setEngine('ai'));
  on('#settings-drawer-toggle', 'click', () => {
    const drawer = $('#settings-drawer');
    const open = drawer.hidden;
    drawer.hidden = !open;
    $('#settings-drawer-toggle').setAttribute('aria-expanded', String(open));
  });
  on('#google-web-open', 'click', () => {
    const cues = state.transcript?.cues;
    const cue = cues?.[state.activeCue] || cues?.[0];
    if (!cue) return;
    window.open(
      googleTranslateUrl(cue.text, $<HTMLSelectElement>('#target-language').value),
      '_blank',
      'noopener,noreferrer',
    );
  });
  on('#summarize-btn', 'click', summarize);
  on('#cancel-job', 'click', () => state.job?.abort());
  on('#search', 'input', () => {
    state.query = $<HTMLInputElement>('#search').value.trim();
    state.windowStart = 0;
    setFollow(!state.query);
    renderTranscript();
    if (!state.query) followCurrent();
  });
  on('#follow-btn', 'click', () => {
    setFollow(!state.follow);
    if (state.follow) {
      state.query = '';
      $<HTMLInputElement>('#search').value = '';
      renderTranscript();
      followCurrent();
    }
  });
  for (const event of ['wheel', 'touchmove'])
    $('#transcript-list').addEventListener(event, () => setFollow(false), { passive: true });
  on('#display-mode', 'change', () => applyDisplayMode($<HTMLSelectElement>('#display-mode').value as DisplayMode));
  on('#font-size', 'change', () => {
    $('#transcript-list').classList.toggle(
      'large-captions',
      $<HTMLSelectElement>('#font-size').value === 'large',
    );
  });
  on('#overlay-enabled', 'change', updatePlayback);
  on('#target-language', 'change', async () => {
    const targetLanguage = $<HTMLSelectElement>('#target-language').value;
    cancelTranslator();
    state.translations = {};
    $('#google-web-fallback').hidden = true;
    resetResults();
    renderTranscript();
    updatePlayback();
    state.settings = await send<PublicSettings>({
      type: 'settings:save',
      settings: { targetLanguage },
    });
    updateActions();
    const version = state.loadVersion;
    void primeTranslations(version).finally(() => {
      if (version === state.loadVersion) maybeTranslate();
    });
  });
  $('#question-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const text = $<HTMLTextAreaElement>('#question').value;
    const submit = state.askScope === 'library' ? searchLibrary(text) : ask(text);
    void submit.catch((error: unknown) => notice(errorMessage(error), true));
  });
  $('#question').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $<HTMLFormElement>('#question-form').requestSubmit();
    }
  });
  on('#settings-open', 'click', openSettings);
  $('#settings-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void saveSettings();
  });
  document.querySelectorAll<HTMLButtonElement>('.scope-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const scope = chip.dataset.scope === 'library' ? 'library' : 'video';
      if (scope === state.askScope) return;
      state.askScope = scope;
      renderAskScope();
      updateActions();
    });
  });
  on('#mode-byok', 'click', () => switchMode('byok'));
  on('#mode-hosted', 'click', () => switchMode('hosted'));
  on('#account-signout', 'click', async () => {
    await send<PublicSettings>({ type: 'account:signOut' });
    // Back to the sign-in screen. Nothing is deleted, from the account or from this machine.
    location.reload();
  });
  on('#account-refresh', 'click', async () => {
    const status = await send<{ usage: { jobsToday: number; dailyJobLimit: number } }>({
      type: 'account:status',
    });
    const left = Math.max(0, status.usage.dailyJobLimit - status.usage.jobsToday);
    $('#account-summary').textContent =
      status.usage.dailyJobLimit === 0
        ? // Zero is not an exhausted day: it is an account the subscription has not been opened for.
          `已登录 ${state.settings?.accountEmail || ''}。当前账号未开通订阅，AI 任务请改用自己的 Key。`
        : `已登录 ${state.settings?.accountEmail || ''}。今日还可发起 ${left} 个任务。`;
  });
  on('#test-connection', 'click', async () => {
    if (testingConnection) return;
    testingConnection = true;
    const version = connectionFormVersion;
    updateConnectionTest();
    const displayResult = (message: string) => {
      if (version !== connectionFormVersion || !$<HTMLDialogElement>('#settings-dialog').open)
        return;
      $('#settings-error').hidden = false;
      $('#settings-error').textContent = message;
    };
    try {
      await send({ type: 'ai:test' });
      displayResult('连接成功，模型可以正常响应。');
    } catch (error) {
      displayResult(errorMessage(error));
    } finally {
      testingConnection = false;
      updateConnectionTest();
    }
  });
  on('#clear-key', 'click', async () => {
    connectionFormChanged();
    state.settings = await send<PublicSettings>({ type: 'settings:clearKey' });
    $<HTMLInputElement>('#api-key').value = '';
    $('#key-status').textContent = '密钥已清除。';
    updateConnectionTest();
    updateActions();
  });
  on('#clear-cache', 'click', async () => {
    await clearCache();
    toast('本机缓存已清除，账号里保存的结果不受影响');
  });
  on('#prompt-open', 'click', () => {
    $<HTMLTextAreaElement>('#prompt-text').value = state.settings?.prompt || PRESETS.learn;
    $<HTMLDialogElement>('#prompt-dialog').showModal();
  });
  on('#save-prompt', 'click', async () => {
    const prompt = $<HTMLTextAreaElement>('#prompt-text').value.trim();
    if (!prompt) throw new Error('请填写总结要求。');
    state.settings = await send<PublicSettings>({ type: 'settings:save', settings: { prompt } });
    $<HTMLDialogElement>('#prompt-dialog').close();
    resetResults();
    toast('Prompt 已保存，下次生成时生效');
  });
  on('#export-open', 'click', () => {
    const menu = $('#export-menu');
    menu.hidden = !menu.hidden;
    $('#export-open').setAttribute('aria-expanded', String(!menu.hidden));
    describeSubtitleExport();
  });
  on('#export-menu', 'change', describeSubtitleExport);
  on('#export-subtitles', 'click', exportSubtitles);
  on('#panel-close', 'click', async () => {
    state.job?.abort();
    if (tabId < 0) window.close();
    else await command({ action: 'close' });
  });
  document.querySelector('.tabs')?.addEventListener('keydown', (input) => {
    const event = input as KeyboardEvent;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const current = TABS.indexOf(state.tab as (typeof TABS)[number]);
    const index =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? TABS.length - 1
          : (current + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length;
    event.preventDefault();
    const tab = TABS[index];
    if (tab) {
      showTab(tab);
      $(`#tab-${tab}`).focus();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeExport();
  });
  window.addEventListener('pagehide', () => {
    state.job?.abort();
    cancelTranslator();
  });
  chrome.runtime.onMessage.addListener((event: RuntimeEvent) => {
    if (!workspace && event.type === 'video:update' && event.tabId === tabId)
      updateVideo(event.video);
  });
  if (workspace)
    window.addEventListener('message', (event) => {
      if (event.source !== window.parent || event.origin !== location.origin) return;
      if (event.data?.type === 'sidenote:learning-video')
        updateVideo(event.data.video as VideoInfo);
      if (event.data?.type === 'sidenote:learning-action') {
        if (event.data.action === 'settings') $('#settings-open').click();
        if (event.data.action === 'guide') $('#guide-open').click();
        if (event.data.action === 'lookup' && typeof event.data.value === 'string')
          void explainInPanel(event.data.value, state.activeCue, 'word').catch((error: unknown) =>
            notice(errorMessage(error), true),
          );
        if (event.data.action === 'explain-line') {
          const cue = state.transcript?.cues[state.activeCue];
          if (cue)
            void explainInPanel(cue.text, state.activeCue, 'sentence').catch((error: unknown) =>
              notice(errorMessage(error), true),
            );
        }
        // The CC button cycles the same setting the drawer's 字幕显示 does, so the two agree.
        if (event.data.action === 'captions-mode' && typeof event.data.value === 'string') {
          const wanted = event.data.value;
          const showing = wanted !== 'off';
          $<HTMLInputElement>('#overlay-enabled').checked = showing;
          if (showing) applyDisplayMode(wanted as DisplayMode);
          else {
            updatePlayback();
            publishPreferences();
          }
        }
        if (event.data.action === 'captions' && typeof event.data.value === 'boolean') {
          $<HTMLInputElement>('#overlay-enabled').checked = event.data.value;
          updatePlayback();
        }
      }
    });
}

function bindGuide(): void {
  const steps = [
    [
      '进入即翻，无需 Key',
      '默认使用 Google 云端翻译（「默认字幕」），免 Key、免下载语言包，字幕载入后随播放自动显示双语。想用自己的模型时，点字幕区的「AI 字幕」切换到已配置的 AI。',
    ],
    [
      '字幕跟着视频走',
      '优先读取 YouTube 原生字幕；没有字幕时可导入 SRT / VTT。点击一句字幕就能跳转，手动滚动后点击恢复跟随。',
    ],
    [
      '双语字幕自动跟随',
      '字幕载入后自动随播放逐句翻译，视频下方与右侧列表同步显示双语，当前句高亮。AI 翻译优先翻译播放位置附近以节省额度；需要整片译文可点「翻译全部」，或切换到 Google 引擎一次译完。可随时关闭自动翻译或切换原文 / 译文。',
    ],
    [
      '总结按你的要求输出',
      '在 AI 设置中选择 OpenAI、DeepSeek 或 Claude，再选择模型并填写 Key。生成 AI 总结后，「章节」标签会像书本目录一样列出内容小结，点标题即可回看对应片段。',
    ],
    [
      '把收获带走',
      '用 AI 问答深入理解内容。笔记、术语和总结保存在你的账号里，换台电脑也在；导出支持 PDF、XMind 和 Markdown，都在本机生成。关闭学习页面会取消进行中的 AI 任务。',
    ],
  ];
  let index = 0;
  const render = () => {
    const step = steps[index];
    if (!step) return;
    $('#guide-title').textContent = step[0] || '';
    $('#guide-copy').textContent = step[1] || '';
    $('#guide-count').textContent = `0${index + 1} / 05`;
    $<HTMLButtonElement>('#guide-prev').disabled = index === 0;
    $('#guide-next').textContent = index === 4 ? '开始学习' : '下一步';
  };
  on('#guide-open', 'click', () => {
    index = 0;
    render();
    $<HTMLDialogElement>('#guide-dialog').showModal();
  });
  on('#guide-prev', 'click', () => {
    index = Math.max(0, index - 1);
    render();
  });
  on('#guide-next', 'click', () => {
    if (index === 4) $<HTMLDialogElement>('#guide-dialog').close();
    else {
      index++;
      render();
    }
  });
}

async function initialize(): Promise<void> {
  state.settings = await send<PublicSettings>({ type: 'settings:get' });
  // Notes and results are kept in the account, so there is nothing to use until there is one.
  if (!state.settings.hasSession) {
    document.body.classList.add('signed-out');
    on('#sign-in', 'click', signIn);
    return;
  }
  try {
    bindEvents();
    bindGuide();
  } catch (error) {
    // A control this panel needs is missing, which means panel.html and panel.js came from
    // different builds. Every button would be dead and the header would sit on its placeholder,
    // looking like a video that never connects. Raw DOM here: the helpers are what just failed.
    const title = document.querySelector('#video-title');
    if (title) title.textContent = '扩展文件版本不一致';
    const list = document.querySelector('#transcript-list');
    if (list)
      list.textContent = '面板文件和程序来自不同的构建，请到 chrome://extensions 重新加载扩展。';
    throw error;
  }
  updateActions();
  $<HTMLInputElement>('#auto-translate').checked = state.settings.autoTranslate !== false;
  updateActions();
  const language = $<HTMLSelectElement>('#target-language');
  if (![...language.options].some((option) => option.value === state.settings?.targetLanguage))
    language.add(new Option(state.settings.targetLanguage, state.settings.targetLanguage));
  language.value = state.settings.targetLanguage;
  publishPreferences();
  // Deliberately not awaited: it is one request to the hosted server, and the panel must paint
  // whether or not that server answers.
  void refreshLibrarySearch();
  // Notes from before accounts go up once; with none left this never reaches the network.
  void uploadLegacyClips(cloud).catch(() => undefined);
  if (params.has('settings') || !Number.isInteger(tabId) || tabId < 0) {
    $('#video-title').textContent = '打开 YouTube 视频，开始学习';
    $('#transcript-list').innerHTML =
      '<div class="empty"><h2>在视频页面使用旁听</h2><p>打开 YouTube 视频后，点击浏览器工具栏中的旁听图标。</p></div>';
    openSettings();
    return;
  }
  try {
    updateVideo(await send<VideoInfo>({ type: 'video:get', tabId }));
  } catch (error) {
    $('#video-title').textContent = '尚未连接到视频';
    notice(errorMessage(error), true);
  }
}

void initialize().catch((error: unknown) => notice(errorMessage(error), true));
