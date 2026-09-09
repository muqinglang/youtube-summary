import '../shared/zod-setup';
import { type ProgressCallback } from './ai-service';
import { createRunner } from './runner';
import { HostedClient } from './hosted';
import { AiError, safeError } from './client';
import {
  clearKey,
  clearSession,
  getPrivateSettings,
  getPublicSettings,
  restrictStorageAccess,
  saveSession,
  saveSettings,
} from './settings';
import { summarySchema, videoSchema } from './validation';
import { ensureEmbedIdentity, openLearningFromSender, openLearningFromTab } from './learning';
import type { AiRequest, AiResult, ExportDocument, Reply, RuntimeRequest } from '../shared/types';

const jobs = new Map<string, { controller: AbortController; owner: object }>();
const ready = restrictStorageAccess();
// Player identity setup is independent: a failure must not disable settings or AI.
void ensureEmbedIdentity().catch(() => undefined);
const JOB_TIMEOUT_MS = 30 * 60_000;

function isExtensionSender(sender: chrome.runtime.MessageSender): boolean {
  return (
    sender.id === chrome.runtime.id && Boolean(sender.url?.startsWith(chrome.runtime.getURL('')))
  );
}

function isYoutubeUrl(raw: string | undefined): boolean {
  try {
    const url = new URL(raw ?? '');
    return (
      url.protocol === 'https:' &&
      ['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

function validateJobId(jobId: unknown): asserts jobId is string {
  if (typeof jobId !== 'string' || !/^[\w-]{1,100}$/.test(jobId))
    throw new AiError('任务编号无效。');
}

async function executeJob(
  jobId: string,
  request: AiRequest,
  owner: object,
  onProgress: ProgressCallback,
): Promise<AiResult> {
  validateJobId(jobId);
  if (jobs.has(jobId)) throw new AiError('任务已在运行。');
  if (jobs.size >= 2) throw new AiError('已有两个 AI 任务在运行，请等待完成或取消任务。');
  const controller = new AbortController();
  jobs.set(jobId, { controller, owner });
  const timer = setTimeout(() => controller.abort(), JOB_TIMEOUT_MS);
  try {
    await ready;
    const settings = await getPrivateSettings();
    return await createRunner(settings).run(request, controller.signal, onProgress);
  } finally {
    clearTimeout(timer);
    jobs.delete(jobId);
  }
}

function cancelJob(jobId: string, owner?: object): void {
  const job = jobs.get(jobId);
  if (job && (!owner || owner === job.owner)) job.controller.abort();
}

async function sendToYoutube(
  request: Extract<RuntimeRequest, { tabId: number }>,
): Promise<unknown> {
  if (!Number.isInteger(request.tabId) || request.tabId < 0) throw new AiError('视频标签页无效。');
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(request.tabId);
  } catch {
    throw new AiError('视频标签页已关闭，请重新打开。');
  }
  if (!isYoutubeUrl(tab.url)) throw new AiError('请在 YouTube 视频页使用此功能。');
  if (request.type === 'player:command') {
    const command = request.command;
    if (!command || typeof command.action !== 'string') throw new AiError('播放操作无效。');
    if (
      command.action === 'seek' &&
      (!Number.isFinite(command.time) || command.time < 0 || command.time > 604800)
    )
      throw new AiError('播放时间无效。');
    if (
      command.action === 'speed' &&
      ![0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4].includes(command.speed)
    )
      throw new AiError('播放速度无效。');
    if (
      command.action === 'overlay' &&
      (typeof command.original !== 'string' ||
        typeof command.translated !== 'string' ||
        command.original.length + command.translated.length > 30000)
    )
      throw new AiError('字幕内容过长。');
  }
  let reply: Reply<unknown>;
  try {
    reply = (await chrome.tabs.sendMessage(request.tabId, request)) as Reply<unknown>;
  } catch {
    throw new AiError('尚未连接视频页面，请刷新 YouTube 页面后重试。');
  }
  if (!reply?.ok) throw new AiError(reply?.error?.slice(0, 500) || '视频页面操作未完成。');
  return reply.data;
}

async function exportPrint(
  request: Extract<RuntimeRequest, { type: 'export:print' }>,
): Promise<{ id: string }> {
  const video = videoSchema.safeParse(request.video);
  const summary = summarySchema.safeParse(request.summary);
  if (
    !video.success ||
    !summary.success ||
    typeof request.prompt !== 'string' ||
    request.prompt.length > 8000
  )
    throw new AiError('导出内容无效，请先生成总结。');
  const id = crypto.randomUUID();
  const document: ExportDocument = {
    video: video.data,
    summary: summary.data,
    prompt: request.prompt,
    createdAt: new Date().toISOString(),
  };
  if (JSON.stringify(document).length > 400000) throw new AiError('导出文档过大，请减少总结长度。');
  const stored = await chrome.storage.session.get('export:ids');
  const previous = Array.isArray(stored['export:ids'])
    ? stored['export:ids'].filter((value): value is string => typeof value === 'string')
    : [];
  const retained = previous.slice(-4);
  await chrome.storage.session.remove(previous.slice(0, -4).map((value) => `export:${value}`));
  await chrome.storage.session.set({ [`export:${id}`]: document, 'export:ids': [...retained, id] });
  await chrome.tabs.create({ url: chrome.runtime.getURL(`export.html?id=${id}`) });
  return { id };
}

async function dispatch(
  request: RuntimeRequest,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  await ready;
  if (request.type === 'learning:open') return openLearningFromSender(sender);
  if (request.type === 'tab:id') {
    if (!isYoutubeUrl(sender.url) || sender.tab?.id === undefined)
      throw new AiError('当前页面不支持此功能。');
    return sender.tab.id;
  }
  if (!isExtensionSender(sender)) throw new AiError('此操作只允许在扩展面板中执行。');
  switch (request.type) {
    case 'settings:get':
      return getPublicSettings();
    case 'settings:save':
      try {
        return await saveSettings(request.settings);
      } catch {
        throw new AiError('设置保存失败，请检查 API 地址、模型名称、语言和提示词长度。');
      }
    case 'settings:clearKey':
      return clearKey();
    case 'ai:test': {
      const controller = new AbortController();
      return createRunner(await getPrivateSettings()).test(controller.signal);
    }
    case 'account:signIn': {
      const email = typeof request.email === 'string' ? request.email.trim() : '';
      const password = typeof request.password === 'string' ? request.password : '';
      if (!email || password.length < 10) throw new AiError('请填写邮箱，密码至少 10 位。');
      const settings = await getPrivateSettings();
      const controller = new AbortController();
      const client = new HostedClient(settings.serverUrl, '', {});
      const account = request.create
        ? await client.register(email, password, controller.signal)
        : await client.login(email, password, controller.signal);
      return saveSession(account.token, account.user.email);
    }
    case 'account:signOut':
      return clearSession();
    case 'account:status': {
      const settings = await getPrivateSettings();
      if (!settings.sessionToken) throw new AiError('尚未登录托管服务。');
      const controller = new AbortController();
      return new HostedClient(settings.serverUrl, settings.sessionToken, {}).me(controller.signal);
    }
    case 'ai:run':
      return executeJob(request.jobId, request.request, sender, (progress) => {
        void chrome.runtime
          .sendMessage({ type: 'ai:progress', progress: { jobId: request.jobId, ...progress } })
          .catch(() => undefined);
      });
    case 'ai:cancel':
      validateJobId(request.jobId);
      cancelJob(request.jobId);
      return null;
    case 'video:get':
    case 'transcript:get':
    case 'player:command':
      return sendToYoutube(request);
    case 'export:print':
      return exportPrint(request);
    default:
      throw new AiError('不支持此操作。');
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (
    sender.id !== chrome.runtime.id ||
    !message ||
    typeof message !== 'object' ||
    !('type' in message)
  )
    return false;
  if (message.type === 'video:update') {
    if (sender.tab?.id === undefined || !isYoutubeUrl(sender.url)) return false;
    const video = videoSchema.safeParse('video' in message ? message.video : undefined);
    if (video.success) {
      void chrome.runtime
        .sendMessage({ type: 'video:update', tabId: sender.tab.id, video: video.data })
        .catch(() => undefined);
    }
    return false;
  }
  if (message.type === 'ai:progress' || message.type === 'ai:result' || message.type === 'ai:error')
    return false;
  void dispatch(message as RuntimeRequest, sender)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error: unknown) => sendResponse({ ok: false, error: safeError(error) }));
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidenote-panel' || !port.sender || !isExtensionSender(port.sender)) {
    port.disconnect();
    return;
  }
  let connected = true;
  const post = (message: unknown) => {
    if (connected) {
      try {
        port.postMessage(message);
      } catch {
        connected = false;
      }
    }
  };
  port.onMessage.addListener((message: unknown) => {
    if (!message || typeof message !== 'object' || !('type' in message)) return;
    // Receiving an explicit heartbeat during an active job keeps MV3's idle timer alive.
    if (message.type === 'heartbeat') return;
    if (message.type === 'ai:cancel' && 'jobId' in message && typeof message.jobId === 'string') {
      cancelJob(message.jobId, port);
      return;
    }
    if (message.type !== 'ai:run' || !('jobId' in message) || !('request' in message)) return;
    const jobId = typeof message.jobId === 'string' ? message.jobId : '';
    void executeJob(jobId, message.request as AiRequest, port, (progress) =>
      post({ type: 'ai:progress', progress: { jobId, ...progress } }),
    )
      .then((result) => post({ type: 'ai:result', jobId, result }))
      .catch((error: unknown) => post({ type: 'ai:error', jobId, error: safeError(error) }));
  });
  port.onDisconnect.addListener(() => {
    connected = false;
    for (const job of jobs.values()) if (job.owner === port) job.controller.abort();
  });
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  const tabId = tab.id;
  void chrome.tabs
    .get(tabId)
    .then((current) => ready.then(() => openLearningFromTab(current)))
    .then(() => chrome.action.setBadgeText({ tabId, text: '' }))
    .catch(() => {
      void chrome.action.setBadgeText({ tabId, text: '!' });
      void chrome.action.setTitle({
        tabId,
        title: '请打开 YouTube 视频，并刷新页面后再次点击旁听。',
      });
    });
});
