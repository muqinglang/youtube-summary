import '../shared/zod-setup';
import { buildMarkdown, buildXMind } from '../core/exports';
import { findCueIndex, formatTime, parseTranscript } from '../core/transcript';
import { getOriginPattern } from '../shared/endpoint';
import { getProvider, PROVIDERS } from '../shared/providers';
import type {
  AiRequest,
  AiProvider,
  AiResult,
  Answer,
  Clip,
  Cue,
  ExportDocument,
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
  VideoChapter,
  VideoInfo,
} from '../shared/types';
import { cacheKey, clearCache, readCache, writeCache } from './cache';
import { readClips, writeClips } from './notes';
import { downloadFile, element as $, errorMessage, escapeHtml as esc } from './dom';
import { runJob, send } from './runtime';
import { googleTranslateUrl, resolveTranslationEngine } from './google-translate';
import { translateCuesCloud } from './cloud-translate';

const TABS = ['transcript', 'chapters', 'guide', 'glossary', 'notes', 'summary', 'chat'] as const;
type Tab = (typeof TABS)[number];
type DisplayMode = 'bilingual' | 'original' | 'translated';
const params = new URLSearchParams(location.search);
const workspace = params.has('workspace') && window.parent !== window;
if (workspace) document.body.classList.add('workspace-panel');
const rawTabId = params.get('tabId');
const tabId = rawTabId === null ? -1 : Number(rawTabId);
const WINDOW_SIZE = 100;
const PRESETS = {
  learn:
    '请完整总结视频中的核心观点、章节、案例和可执行建议，保留相关时间戳。面向初学者解释重要概念，只依据视频内容，不编造信息。',
  quick: '请用简洁语言概括完整视频，重点提炼三个核心观点。保留关键例子和时间戳，省略重复铺垫。',
  action:
    '请把视频整理成可执行的行动清单。每条说明要做什么、如何开始，并保留对应时间戳。不添加视频未提及的承诺或事实。',
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
  job?: AbortController;
  jobTask?: AiRequest['task'];
} = {
  translations: {},
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
  clips: [],
};
let toastTimer = 0;
let commentSaveTimer = 0;
let lastOverlay = '';
let savingTranslationEngine = false;
const attemptedTrackSets = new Set<string>();
let lastPreferences = '';
let testingConnection = false;
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
      answer.textContent = item.answer || '字幕中没有给出明确答案，请到对应时间点自行判断。';

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

function renderClips(): void {
  const list = $('#notes-list');
  const clips = state.clips;
  list.hidden = !clips.length;
  $('#notes-empty').hidden = Boolean(clips.length);
  $('#notes-count').textContent = clips.length ? `${clips.length} 条` : '';
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
      remove.dataset.unclip = clip.id;
      remove.textContent = '删除';
      head.append(jump, remove);

      const text = document.createElement('p');
      text.className = 'clip-text';
      text.textContent = clip.text;
      card.append(head, text);
      if (clip.translation) {
        const translation = document.createElement('p');
        translation.className = 'clip-translation';
        translation.textContent = clip.translation;
        card.append(translation);
      }

      const comment = document.createElement('textarea');
      comment.className = 'clip-comment';
      comment.rows = 2;
      comment.maxLength = 2000;
      comment.placeholder = '写下你的想法…';
      comment.value = clip.comment;
      comment.dataset.comment = clip.id;
      card.append(comment);
      return card;
    }),
  );
}

/** Clips belong to the video, not to a session, so they are reloaded whenever it changes. */
async function loadClips(videoId: string): Promise<void> {
  const version = state.loadVersion;
  const clips = await readClips(videoId);
  if (version !== state.loadVersion || state.video?.id !== videoId) return;
  state.clips = clips;
  renderClips();
}

async function persistClips(): Promise<void> {
  if (!state.video) return;
  await writeClips(state.video.id, state.clips);
}

/** Keeps the line, its translation and where it came from, so a note stands on its own later. */
async function addClip(start: number, text: string, translation: string): Promise<void> {
  if (!state.video || !text.trim()) return;
  if (state.clips.some((clip) => clip.start === start && clip.text === text)) {
    toast('这一条已经剪藏过了');
    return;
  }
  state.clips = [
    ...state.clips,
    {
      id: crypto.randomUUID(),
      start,
      text: text.trim(),
      translation: translation.trim(),
      comment: '',
      createdAt: new Date().toISOString(),
    },
  ].sort((a, b) => a.start - b.start);
  renderClips();
  await persistClips();
  toast('已剪藏');
}

async function clipActiveCue(): Promise<void> {
  const cue = state.transcript?.cues[state.activeCue];
  if (!cue) {
    notice('还没有正在播放的字幕可以剪藏。');
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

async function generateGuide(): Promise<void> {
  const context = aiContext();
  const result = await run({ task: 'guide', ...context }, Boolean(state.guide));
  if (result?.task !== 'guide') return;
  state.guide = result.guide;
  renderGuide();
  showTab('guide');
  toast(`已生成 ${result.guide.questions.length} 个引导问题`);
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
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  for (const name of TABS) {
    $(`#view-${name}`).hidden = name !== tab;
  }
  closeExport();
  if (tab === 'transcript' && state.follow) followCurrent();
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
    '<div class="empty-mark">AI</div><h2>把视频，变成清晰笔记</h2><p>生成带时间点的章节总结、核心观点和行动建议。</p>';
  $<HTMLButtonElement>('#export-open').disabled = true;
  $('#summarize-btn').textContent = '生成视频总结';
}

function resetVideo(): void {
  state.loadVersion++;
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
  void command({ action: 'overlay', original: '', translated: '', visible: false }).catch(() => {});
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
  $('#source-state').textContent = transcript.source === 'import' ? '已导入字幕' : '已读取原生字幕';
  const first = transcript.cues[0];
  const last = transcript.cues.at(-1);
  $('#caption-range').textContent =
    first && last ? `${formatTime(first.start)} - ${formatTime(last.end)}` : '';
  notice(
    transcript.coverage === 'unknown' ? '字幕覆盖范围未验证；AI 将只处理当前已载入的内容。' : '',
  );
  renderTranscript();
  updatePlayback();
  updateActions();
  cancelTranslator();
  const version = state.loadVersion;
  void primeTranslations(version).finally(() => {
    if (version === state.loadVersion) maybeTranslate();
  });
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
function markTerms(escaped: string, terms: GlossaryTerm[]): string {
  const haystack = escaped.toLocaleLowerCase();
  const ranges: { at: number; end: number; term: GlossaryTerm }[] = [];
  for (const term of terms) {
    const needle = esc(term.term).toLocaleLowerCase();
    if (!needle) continue;
    const at = haystack.indexOf(needle);
    if (at < 0) continue;
    const end = at + needle.length;
    // A term already covered by an earlier mark is skipped rather than nested.
    if (ranges.some((range) => at < range.end && range.at < end)) continue;
    ranges.push({ at, end, term });
  }
  ranges.sort((a, b) => a.at - b.at);
  let output = '';
  let cursor = 0;
  for (const { at, end, term } of ranges) {
    const hint = `${TERM_LABELS[term.kind]} · ${term.meaning || '字幕中没有给出解释。'}`;
    output += `${escaped.slice(cursor, at)}<span class="term-mark" title="${esc(hint)}">${escaped.slice(at, end)}</span>`;
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
  const clip = document.createElement('button');
  clip.className = 'explain-trigger';
  clip.dataset.clipSelection = 'true';
  clip.textContent = '剪藏这段';
  $('#explain-bubble').replaceChildren(trigger, clip);
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

function renderExplanation(explanation: Explanation): void {
  const bubble = $('#explain-bubble');
  const head = document.createElement('div');
  head.className = 'explain-head';
  const kind = document.createElement('span');
  kind.className = 'term-kind';
  kind.textContent = TERM_LABELS[explanation.kind];
  const name = document.createElement('span');
  name.className = 'term-name';
  name.textContent = explanation.term;
  head.append(kind, name);
  const meaning = document.createElement('p');
  meaning.className = 'explain-meaning';
  meaning.textContent = explanation.meaning;
  bubble.replaceChildren(head, meaning);
  const spots = occurrences(explanation.term);
  if (spots.length > 1) {
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
    bubble.append(row);
  }
}

async function explainSelection(): Promise<void> {
  const cues = state.transcript?.cues;
  if (!cues || !state.video || !state.transcript || !selectedTerm) return;
  const centre = selectedCue >= 0 ? selectedCue : 0;
  const bubble = $('#explain-bubble');
  const pending = document.createElement('p');
  pending.className = 'explain-meaning';
  pending.textContent = '正在解释…';
  bubble.replaceChildren(pending);
  const result = await run({
    task: 'explain',
    video: state.video,
    // A window around the selection: enough context to be specific, small enough to be quick.
    transcript: { ...state.transcript, cues: cues.slice(Math.max(0, centre - 8), centre + 9) },
    term: selectedTerm,
    language: $<HTMLSelectElement>('#target-language').value,
  });
  if (result?.task !== 'explain') return hideExplain();
  renderExplanation(result.explanation);
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
    const source = marked ? markTerms(esc(cue.text), marked) : esc(cue.text);
    const original =
      state.displayMode !== 'translated' ? `<span class="original">${source}</span>` : '';
    const translated =
      state.displayMode !== 'original' && state.translations[cue.id]
        ? `<span class="translation">${esc(state.translations[cue.id] || '')}</span>`
        : '';
    const pending =
      !original && !translated
        ? '<span class="translation">尚未翻译，请点击上方「翻译」。</span>'
        : '';
    parts.push(
      `<button class="cue${index === state.activeCue ? ' active' : ''}" data-cue="${index}"${index === state.activeCue ? ' aria-current="true"' : ''}><time>${formatTime(cue.start)}</time>${original}${translated}${pending}</button>`,
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
  const overlay = {
    original: state.displayMode === 'translated' ? '' : cue?.text || '',
    translated: state.displayMode === 'original' ? '' : state.translations[cue?.id || ''] || '',
    visible: $<HTMLInputElement>('#overlay-enabled').checked && Boolean(cue),
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
    `<span class="result-badge">${state.transcript?.coverage === 'complete' ? '视频字幕总结' : '当前字幕范围总结'}</span><h2 class="summary-title">${esc(summary.title)}</h2><p class="summary-overview">${esc(summary.overview)}</p>${sections}<section class="takeaways"><h3>带走这些收获</h3><ol>${summary.takeaways.map((point) => `<li>${esc(point)}</li>`).join('')}</ol></section>`;
  $('#summarize-btn').textContent = '重新生成总结';
  $('#summary-disclaimer').textContent = 'AI 可能出错，可点击时间点核对视频原文。';
  $<HTMLButtonElement>('#export-open').disabled = false;
}

function updateActions(): void {
  const unavailable =
    !state.transcript?.cues.length ||
    state.loading ||
    Boolean(state.job) ||
    savingTranslationEngine;
  for (const selector of ['#translate-btn', '#summarize-btn', '#ask-btn'])
    $<HTMLButtonElement>(selector).disabled = unavailable;
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
  // Translation paints subtitles as it goes, and an explanation is a two-second aside; neither
  // should be hidden behind the full-panel waiting card.
  $('#job-status').hidden =
    !state.job || state.jobTask === 'translate' || state.jobTask === 'explain';
  publishPreferences();
}

/** Minutes-long waits need something to read, so the card rotates honest notes about the work. */
const WAITING_NOTES = [
  '正在逐段读完整片字幕，再汇总成笔记。',
  '视频越长段数越多，可以先去忙别的，回来结果还在。',
  '结果会缓存在本机，下次打开同一个视频直接复用。',
  '个别段落读取失败会自动跳过，不影响其余部分。',
  '所有时间点都来自真实字幕，生成后可以点开核对。',
];
const NOTE_INTERVAL_MS = 9000;
let jobTicker = 0;
let jobStartedAt = 0;
let noteIndex = -1;

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
function tickJob(): void {
  const elapsed = Date.now() - jobStartedAt;
  $('#job-elapsed').textContent = `已用 ${formatElapsed(elapsed)}`;
  const next = Math.floor(elapsed / NOTE_INTERVAL_MS) % WAITING_NOTES.length;
  if (next !== noteIndex) {
    noteIndex = next;
    $('#job-hint').textContent = WAITING_NOTES[next]!;
  }
}
function startJobTicker(): void {
  jobStartedAt = Date.now();
  noteIndex = -1;
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
  const total = Math.max(1, progress.total);
  const completed = Math.min(Math.max(0, progress.completed), total);
  // Before the first batch reports back there is no real ratio to show.
  const unknown = progress.total <= 1;
  const ratio = unknown ? 0 : completed / total;
  $('#job-progress').classList.toggle('is-indeterminate', unknown);
  $('#job-progress').setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  $('#job-bar').style.width = unknown ? '' : `${(ratio * 100).toFixed(1)}%`;
  $('#job-step').textContent = unknown ? '' : `${completed} / ${total} 段`;
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
    const key = await cacheKey({
      request: identity,
      model: settings.model,
      baseUrl: settings.baseUrl,
      temperature: settings.temperature,
      // 2: outline sections gained density and kind, so version 1 entries render blank badges.
      version: 3,
    });
    const cached = force ? undefined : await readCache<AiResult>(key);
    if (cached && !controller.signal.aborted && version === state.loadVersion) {
      toast('已使用本地缓存，无需重复处理');
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
const LOOKAHEAD = 60;
const MIN_BATCH = 12;
let translator: AbortController | undefined;
let translateAll = false;
let translationHalted = false;
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

function collectUntranslated(cues: Cue[], from: number, to: number): Cue[] {
  const out: Cue[] = [];
  const end = Math.min(cues.length, to);
  for (let index = Math.max(0, from); index < end && out.length < AI_CHUNK; index += 1) {
    const cue = cues[index];
    if (cue && !state.translations[cue.id]) out.push(cue);
  }
  return out;
}

/** Prefer the window just ahead of the playhead; only sweep the whole video on demand. */
function nextBatch(): Cue[] | undefined {
  const cues = state.transcript?.cues;
  if (!cues?.length) return undefined;
  const active = Math.max(0, state.activeCue);
  const ahead = collectUntranslated(cues, active, active + LOOKAHEAD);
  if (ahead.length) return ahead;
  const behind = collectUntranslated(cues, active - 40, active);
  if (behind.length) return behind;
  // Free cloud Google fills the whole video (like Trancy); paid AI stays near the playhead.
  if (!translateAll && currentEngine() !== 'google') return undefined;
  const first = cues.findIndex((cue) => !state.translations[cue.id]);
  return first < 0 ? undefined : collectUntranslated(cues, first, first + LOOKAHEAD);
}

function untranslatedInWindow(): number {
  const cues = state.transcript?.cues;
  if (!cues?.length) return 0;
  const active = Math.max(0, state.activeCue);
  let count = 0;
  const end = Math.min(cues.length, active + LOOKAHEAD);
  for (let index = active; index < end; index += 1) {
    const cue = cues[index];
    if (cue && !state.translations[cue.id]) count += 1;
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
  if (translator || !state.transcript || translationHalted) return;
  if (!autoTranslateOn() && !translateAll) return;
  if (!engineReady(currentEngine())) return;
  const activeCue = state.transcript.cues[state.activeCue];
  const activeMissing = Boolean(activeCue && !state.translations[activeCue.id]);
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
        const map = await translateCuesCloud(
          batch,
          $<HTMLSelectElement>('#target-language').value,
          controller.signal,
        );
        if (controller.signal.aborted || version !== state.loadVersion) return;
        mergeTranslations(map, true);
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

async function ask(question: string): Promise<void> {
  question = question.trim();
  if (!question || state.job) return;
  const result = await run({ task: 'ask', ...aiContext(), question });
  if (result?.task !== 'ask') return;
  document.querySelector('.chat-welcome')?.remove();
  appendAnswer(question, result.answer);
  $<HTMLTextAreaElement>('#question').value = '';
}

function appendAnswer(question: string, answer: Answer): void {
  const item = document.createElement('section');
  item.innerHTML = `<div class="user-message">${esc(question)}</div><div class="answer"><span class="answer-label">旁听 AI</span><p>${esc(answer.text)}</p>${answer.citations.map((citation) => `<button class="citation" data-seek="${citation.start}">${formatTime(citation.start)} · ${esc(citation.label)} ↗</button>`).join('')}</div>`;
  $('#messages').append(item);
  $('#messages').scrollTo({ top: $('#messages').scrollHeight, behavior: 'smooth' });
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

async function exportNotes(format: string): Promise<void> {
  closeExport();
  if (format === 'clips') {
    if (!state.clips.length) throw new Error('还没有剪藏任何内容。');
    downloadFile(
      `${state.video?.title ?? '视频'} 笔记.md`,
      clipsMarkdown(),
      'text/markdown;charset=utf-8',
    );
    return;
  }
  const doc = exportDocument();
  if (format === 'pdf') {
    // The bundled subset font is ~1.5 MB, so it is fetched only when a PDF is actually exported.
    const [{ buildPdf }, response] = await Promise.all([
      import('../core/pdf'),
      fetch(chrome.runtime.getURL('fonts/NotoSansSC-Subset.otf')),
    ]);
    if (!response.ok) throw new Error('中文字体加载失败，无法生成 PDF。');
    const pdf = await buildPdf(doc, { font: new Uint8Array(await response.arrayBuffer()) });
    downloadFile(`${doc.summary.title}.pdf`, pdf, 'application/pdf');
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
  $('#mode-byok').setAttribute('aria-selected', String(!hosted));
  $('#mode-hosted').setAttribute('aria-selected', String(hosted));
  const hostedFields = $<HTMLFieldSetElement>('#hosted-fields');
  const byokFields = $<HTMLFieldSetElement>('#byok-fields');
  hostedFields.hidden = !hosted;
  hostedFields.disabled = !hosted;
  byokFields.hidden = hosted;
  byokFields.disabled = hosted;
  $('#byok-actions').hidden = hosted;
  const signedIn = Boolean(state.settings?.hasSession);
  $('#account-out').hidden = signedIn;
  $('#account-in').hidden = !signedIn;
  $('#account-summary').textContent = signedIn
    ? `已登录 ${state.settings?.accountEmail || ''}。点「刷新额度」查看今日剩余。`
    : '';
  $('#mode-hint').textContent = hosted
    ? '任务在旁听服务端运行，消耗账号额度。同一个视频别人处理过就直接复用，不重复计费。'
    : '任务在本机运行，直连你自己的 API Key，不经过任何服务器。';
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
}

async function signIn(create: boolean): Promise<void> {
  const email = $<HTMLInputElement>('#account-email').value.trim();
  const password = $<HTMLInputElement>('#account-password').value;
  $('#settings-error').hidden = true;
  try {
    state.settings = await send<PublicSettings>({
      type: 'account:signIn',
      email,
      password,
      create,
    });
    // The password is never kept in the DOM once it has been exchanged for a session.
    $<HTMLInputElement>('#account-password').value = '';
    renderSettingsMode('hosted');
    updateActions();
    toast(create ? '注册成功，已登录' : '登录成功');
  } catch (error) {
    $('#settings-error').hidden = false;
    $('#settings-error').textContent = errorMessage(error);
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
    ? '直连 ' + provider.label + ' 官方服务，地址已内置。模型可用性取决于你的账户权限。'
    : '原有配置已保留。请选择服务商与模型，并填写对应 Key 后更新。';
}

function updateConnectionTest(): void {
  const saved = state.settings;
  if (saved?.mode === 'hosted') {
    $<HTMLButtonElement>('#test-connection').disabled = testingConnection || !saved.hasSession;
    $('#test-connection').textContent = testingConnection
      ? '正在检查账号…'
      : saved.hasSession
        ? '检查账号与额度'
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
      honourSeekUntil = Date.now() + SEEK_GRACE_MS;
      void seek(Number(data.seek)).catch((error: unknown) => notice(errorMessage(error), true));
    }
    if ('clipSelection' in data)
      void clipSelection().catch((error: unknown) => notice(errorMessage(error), true));
    if (data.unclip) {
      state.clips = state.clips.filter((clip) => clip.id !== data.unclip);
      renderClips();
      void persistClips().catch((error: unknown) => notice(errorMessage(error), true));
    }
    if ('explain' in data) {
      void explainSelection().catch((error: unknown) => {
        hideExplain();
        notice(errorMessage(error), true);
      });
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
    if (event.key === 'Escape') hideExplain();
  });
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
  $('#notes-list').addEventListener('input', (event) => {
    const target = event.target as HTMLTextAreaElement;
    const id = target.dataset.comment;
    if (!id) return;
    const clip = state.clips.find((item) => item.id === id);
    if (!clip) return;
    clip.comment = target.value;
    // Typing should not write on every keystroke; the save rides the next idle callback.
    clearTimeout(commentSaveTimer);
    commentSaveTimer = window.setTimeout(() => {
      void persistClips().catch((error: unknown) => notice(errorMessage(error), true));
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
  on('#display-mode', 'change', () => {
    state.displayMode = $<HTMLSelectElement>('#display-mode').value as DisplayMode;
    renderTranscript();
    updatePlayback();
    followCurrent();
  });
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
    void ask($<HTMLTextAreaElement>('#question').value).catch((error: unknown) =>
      notice(errorMessage(error), true),
    );
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
  on('#mode-byok', 'click', () => switchMode('byok'));
  on('#mode-hosted', 'click', () => switchMode('hosted'));
  on('#account-login', 'click', () => signIn(false));
  on('#account-register', 'click', () => signIn(true));
  on('#account-signout', 'click', async () => {
    state.settings = await send<PublicSettings>({ type: 'account:signOut' });
    renderSettingsMode('hosted');
    updateActions();
    toast('已退出登录');
  });
  on('#account-refresh', 'click', async () => {
    const status = await send<{ usage: { jobsToday: number; dailyJobLimit: number } }>({
      type: 'account:status',
    });
    const left = Math.max(0, status.usage.dailyJobLimit - status.usage.jobsToday);
    $('#account-summary').textContent =
      `已登录 ${state.settings?.accountEmail || ''}。今日还可发起 ${left} 个任务。`;
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
    toast('学习缓存已清除');
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
  });
  on('#panel-close', 'click', async () => {
    state.job?.abort();
    if (tabId < 0) window.close();
    else await command({ action: 'close' });
  });
  document.querySelector('.tabs')?.addEventListener('keydown', (input) => {
    const event = input as KeyboardEvent;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const current = TABS.indexOf(state.tab);
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
      '用 AI 问答深入理解内容。导出笔记支持真实 XMind 和 Markdown 文件，PDF 在独立打印页中另存。关闭学习页面会取消进行中的 AI 任务。',
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
  bindEvents();
  bindGuide();
  updateActions();
  state.settings = await send<PublicSettings>({ type: 'settings:get' });
  $<HTMLInputElement>('#auto-translate').checked = state.settings.autoTranslate !== false;
  updateActions();
  const language = $<HTMLSelectElement>('#target-language');
  if (![...language.options].some((option) => option.value === state.settings?.targetLanguage))
    language.add(new Option(state.settings.targetLanguage, state.settings.targetLanguage));
  language.value = state.settings.targetLanguage;
  publishPreferences();
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
