import { z } from 'zod';
import type { VideoInfo } from '../shared/types';
import { AiError } from './client';
import { videoSchema } from './validation';

const EMBED_RULE_ID = 23001;
const INDEX_KEY = 'learning:tabs';
const MAX_SESSIONS = 10;
const videoIdSchema = z.string().regex(/^[A-Za-z0-9_-]{11}$/);
const indexSchema = z
  .array(z.object({ videoId: videoIdSchema, tabId: z.number().int().min(0).optional() }))
  .max(MAX_SESSIONS);
const sessionSchema = z.object({ video: videoSchema, sourceTabId: z.number().int().min(0) });
type LearningSession = z.infer<typeof sessionSchema>;
type LearningIndex = z.infer<typeof indexSchema>;

let embedIdentity: Promise<void> | undefined;
let opening = Promise.resolve();

export function youtubeVideoId(raw: string | undefined): string | null {
  try {
    const url = new URL(raw ?? '');
    if (
      url.protocol !== 'https:' ||
      !['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.port
    )
      return null;
    const id =
      url.pathname === '/watch'
        ? url.searchParams.get('v')
        : url.pathname.match(/^\/(?:shorts|live)\/([A-Za-z0-9_-]{11})\/?$/)?.[1];
    return id && videoIdSchema.safeParse(id).success ? id : null;
  } catch {
    return null;
  }
}

/** Identify only our own embedded player requests with our real extension identity. */
export function ensureEmbedIdentity(): Promise<void> {
  if (!embedIdentity) {
    embedIdentity = Promise.resolve()
      .then(() =>
        chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: [EMBED_RULE_ID],
          addRules: [
            {
              id: EMBED_RULE_ID,
              priority: 1,
              action: {
                type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
                requestHeaders: [
                  {
                    header: 'Referer',
                    operation: chrome.declarativeNetRequest.HeaderOperation.SET,
                    value: `https://sidenote.${chrome.runtime.id}/`,
                  },
                ],
              },
              condition: {
                initiatorDomains: [chrome.runtime.id],
                urlFilter: '|https://www.youtube.com/embed/',
                resourceTypes: [chrome.declarativeNetRequest.ResourceType.SUB_FRAME],
              },
            },
          ],
        }),
      )
      .catch(() => {
        embedIdentity = undefined;
        throw new AiError('学习播放器初始化失败，请重新加载扩展后重试。');
      });
  }
  return embedIdentity;
}

function sessionKey(videoId: string): string {
  return `learning-session:${videoId}`;
}

function learningUrl(video: VideoInfo, sourceTabId: number): string {
  const url = new URL(chrome.runtime.getURL('learn.html'));
  url.search = new URLSearchParams({
    tabId: String(sourceTabId),
    videoId: video.id,
    start: String(Math.max(0, video.currentTime)),
  }).toString();
  return url.href;
}

function storedPageSource(raw: string | undefined, videoId: string): number | null {
  try {
    const url = new URL(raw ?? '');
    if (
      url.protocol !== 'chrome-extension:' ||
      url.hostname !== chrome.runtime.id ||
      url.pathname !== '/learn.html' ||
      url.searchParams.get('videoId') !== videoId
    )
      return null;
    const value = url.searchParams.get('tabId');
    const source = value === null ? NaN : Number(value);
    return Number.isInteger(source) && source >= 0 ? source : null;
  } catch {
    return null;
  }
}

async function learningPageSource(
  tab: chrome.tabs.Tab | undefined,
  videoId: string,
): Promise<number | null> {
  if (tab?.id === undefined) return null;
  const url = tab.pendingUrl ?? tab.url;
  if (url) return storedPageSource(url, videoId);
  // Chrome can hide even our own tab URL without the broad tabs permission.
  // Extension contexts identify only our pages and preserve the same URL checks.
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['TAB'],
      tabIds: [tab.id],
      frameIds: [0],
    });
    for (const context of contexts) {
      if (context.tabId !== tab.id || context.frameId !== 0 || context.contextType !== 'TAB')
        continue;
      const source = storedPageSource(context.documentUrl, videoId);
      if (source !== null) return source;
    }
  } catch {
    // A closed or unloaded context must not cause a different page to be reused.
  }
  return null;
}

async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AiError('视频页面没有响应，请刷新后重试。')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function getTab(tabId: number): Promise<chrome.tabs.Tab | undefined> {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return undefined;
  }
}

async function remember(
  index: LearningIndex,
  session: LearningSession,
  tabId?: number,
): Promise<LearningIndex> {
  const videoId = session.video.id;
  const others = index.filter((entry) => entry.videoId !== videoId);
  const discarded = others.slice(0, Math.max(0, others.length - MAX_SESSIONS + 1));
  const next = [
    ...others.slice(-(MAX_SESSIONS - 1)),
    { videoId, ...(tabId === undefined ? {} : { tabId }) },
  ];
  if (discarded.length)
    await chrome.storage.session.remove(
      discarded.flatMap((entry) => [
        sessionKey(entry.videoId),
        `learning-transcript:${entry.videoId}`,
      ]),
    );
  await chrome.storage.session.set({ [INDEX_KEY]: next, [sessionKey(videoId)]: session });
  return next;
}

async function openFromSource(
  sourceTabId: number,
  expectedVideoId: string,
): Promise<{ tabId: number; reused: boolean }> {
  const source = await getTab(sourceTabId);
  if (youtubeVideoId(source?.pendingUrl ?? source?.url) !== expectedVideoId)
    throw new AiError('源视频页面已切换或关闭，请在当前视频重新打开旁听。');
  let response: unknown;
  try {
    response = await within(
      chrome.tabs.sendMessage(sourceTabId, { type: 'video:get', tabId: sourceTabId }),
      6000,
    );
  } catch {
    throw new AiError('尚未连接视频页面，请刷新 YouTube 页面后重试。');
  }
  const parsed = z.object({ ok: z.literal(true), data: videoSchema }).safeParse(response);
  if (
    !parsed.success ||
    parsed.data.data.id !== expectedVideoId ||
    youtubeVideoId(parsed.data.data.url) !== expectedVideoId
  )
    throw new AiError('视频信息尚未就绪或已切换，请稍后重试。');
  const video = parsed.data.data;
  await ensureEmbedIdentity();
  const latestSource = await getTab(sourceTabId);
  if (youtubeVideoId(latestSource?.pendingUrl ?? latestSource?.url) !== expectedVideoId)
    throw new AiError('源视频页面已切换，请重新打开旁听。');
  // A source that cannot pause must not prevent opening the independent learning page.
  await within(
    chrome.tabs.sendMessage(sourceTabId, {
      type: 'player:command',
      tabId: sourceTabId,
      command: { action: 'pause' },
    }),
    2000,
  ).catch(() => undefined);
  const saved = await chrome.storage.session.get([INDEX_KEY, sessionKey(expectedVideoId)]);
  const entries = indexSchema.safeParse(saved[INDEX_KEY]);
  let index = entries.success ? entries.data : [];
  const entry = index.find((item) => item.videoId === expectedVideoId);
  const previous = sessionSchema.safeParse(saved[sessionKey(expectedVideoId)]);
  const existing = entry?.tabId === undefined ? undefined : await getTab(entry.tabId);
  const existingSource = await learningPageSource(existing, expectedVideoId);
  if (existing?.id !== undefined && existingSource !== null) {
    const oldSource = await getTab(existingSource);
    const retainedSession =
      previous.success &&
      previous.data.sourceTabId === existingSource &&
      previous.data.video.id === expectedVideoId &&
      youtubeVideoId(oldSource?.pendingUrl ?? oldSource?.url) === expectedVideoId
        ? previous.data
        : undefined;
    index = await remember(index, retainedSession ?? { video, sourceTabId }, existing.id);
    try {
      await chrome.tabs.update(
        existing.id,
        retainedSession ? { active: true } : { url: learningUrl(video, sourceTabId), active: true },
      );
      return { tabId: existing.id, reused: true };
    } catch {
      /* The learning tab may close between lookup and activation; create it again. */
    }
  }
  index = await remember(index, { video, sourceTabId });
  let created: chrome.tabs.Tab;
  try {
    created = await chrome.tabs.create({ url: learningUrl(video, sourceTabId), active: true });
    if (created.id === undefined) throw new Error('Tab id missing');
  } catch {
    await chrome.storage.session.remove(sessionKey(expectedVideoId));
    await chrome.storage.session.set({
      [INDEX_KEY]: index.filter((item) => item.videoId !== expectedVideoId),
    });
    throw new AiError('无法打开学习页面，请稍后重试。');
  }
  await remember(index, { video, sourceTabId }, created.id);
  return { tabId: created.id, reused: false };
}

function enqueueOpen(
  sourceTabId: number,
  expectedVideoId: string,
): Promise<{ tabId: number; reused: boolean }> {
  const result = opening.then(() => openFromSource(sourceTabId, expectedVideoId));
  opening = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function openLearningFromSender(
  sender: chrome.runtime.MessageSender,
): Promise<{ tabId: number; reused: boolean }> {
  const id = youtubeVideoId(sender.url);
  const sourceTabId = sender.tab?.id;
  if (
    sender.id !== chrome.runtime.id ||
    !id ||
    sourceTabId === undefined ||
    !Number.isInteger(sourceTabId) ||
    sourceTabId < 0 ||
    (sender.frameId !== undefined && sender.frameId !== 0)
  ) {
    return Promise.reject(new AiError('请从 YouTube 视频页面打开旁听。'));
  }
  return enqueueOpen(sourceTabId, id);
}

export function openLearningFromTab(
  tab: chrome.tabs.Tab,
): Promise<{ tabId: number; reused: boolean }> {
  const id = youtubeVideoId(tab.pendingUrl ?? tab.url);
  if (!id || tab.id === undefined)
    return Promise.reject(new AiError('请先打开 YouTube 视频页面。'));
  return enqueueOpen(tab.id, id);
}
