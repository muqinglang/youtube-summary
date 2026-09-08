import '../shared/zod-setup';
import { z } from 'zod';
import { parseTranscript } from '../core/transcript';
import type { Reply, Transcript } from '../shared/types';
import { LearningLauncher } from './surface';
import {
  captionResultSchema,
  parsePageResponse,
  playbackCommandSchema,
  REQUEST_CHANNEL,
  videoIdFromUrl,
  videoInfoSchema,
  type PageRequest,
} from './protocol';

const runtimeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('video:get'), tabId: z.number().int() }),
  z.object({
    type: z.literal('transcript:get'),
    tabId: z.number().int(),
    trackId: z.string().max(200).optional(),
  }),
  z.object({
    type: z.literal('player:command'),
    tabId: z.number().int(),
    command: playbackCommandSchema,
  }),
]);
const pending = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }
>();
const launcher = new LearningLauncher(() => {
  void openLearning();
});
let opening = false;

async function openLearning() {
  if (opening) return;
  opening = true;
  launcher.setBusy(true);
  try {
    const reply: Reply<unknown> = await chrome.runtime.sendMessage({ type: 'learning:open' });
    if (!reply?.ok)
      throw new Error(reply && !reply.ok ? reply.error : '扩展连接已断开，请刷新 YouTube。');
  } catch (error) {
    launcher.reportError(
      error instanceof Error ? error.message : '无法打开学习页面，请刷新 YouTube 后重试。',
    );
  } finally {
    opening = false;
    launcher.setBusy(false);
  }
}
function requestPage(request: PageRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timeout = setTimeout(
      () => {
        pending.delete(id);
        reject(new Error('YouTube 页面没有响应，请刷新原视频页面后重试。'));
      },
      request.type === 'transcript:get' ? 32_000 : 5_000,
    );
    pending.set(id, { resolve, reject, timeout });
    window.postMessage({ channel: REQUEST_CHANNEL, id, request }, location.origin);
  });
}
function onPageMessage(event: MessageEvent<unknown>) {
  if (event.source !== window || event.origin !== location.origin) return;
  const parsed = parsePageResponse(event.data);
  if (!parsed.success) return;
  const { id, reply } = parsed.data;
  const task = pending.get(id);
  if (!task) return;
  clearTimeout(task.timeout);
  pending.delete(id);
  if (reply.ok) task.resolve(reply.data);
  else task.reject(new Error(reply.error));
}
async function handle(request: z.infer<typeof runtimeSchema>): Promise<unknown> {
  if (request.type === 'video:get') {
    const video = videoInfoSchema.parse(await requestPage({ type: 'video:get' }));
    if (video.id !== videoIdFromUrl(location.href)) throw new Error('视频已切换，请重新打开旁听。');
    return video;
  }
  if (request.type === 'transcript:get') {
    const data = captionResultSchema.parse(
      await requestPage({ type: 'transcript:get', trackId: request.trackId }),
    );
    if (data.videoId !== videoIdFromUrl(location.href))
      throw new Error('视频已切换，请重新读取字幕。');
    const result: Transcript = {
      videoId: data.videoId,
      language: data.language,
      source: 'youtube',
      coverage: data.coverage,
      cues: parseTranscript(data.raw),
    };
    return result;
  }
  return requestPage({ type: 'player:command', command: request.command });
}
function onRuntimeMessage(
  message: unknown,
  sender: chrome.runtime.MessageSender,
  respond: (reply: Reply<unknown>) => void,
) {
  if (sender.id !== chrome.runtime.id) return false;
  const parsed = runtimeSchema.safeParse(message);
  if (!parsed.success) return false;
  void handle(parsed.data).then(
    (data) => respond({ ok: true, data }),
    (error: unknown) =>
      respond({
        ok: false,
        error: error instanceof Error ? error.message : '字幕读取未完成，请重试。',
      }),
  );
  return true;
}
function attach() {
  launcher.attach(Boolean(videoIdFromUrl(location.href)));
}
window.addEventListener('message', onPageMessage);
chrome.runtime.onMessage.addListener(onRuntimeMessage);
document.addEventListener('yt-navigate-finish', attach);
const poll = setInterval(attach, 1000);
attach();
window.addEventListener('pagehide', (event) => {
  if (event.persisted) return;
  clearInterval(poll);
  window.removeEventListener('message', onPageMessage);
  document.removeEventListener('yt-navigate-finish', attach);
  chrome.runtime.onMessage.removeListener(onRuntimeMessage);
  for (const task of pending.values()) {
    clearTimeout(task.timeout);
    task.reject(new Error('原视频页面已关闭。'));
  }
  pending.clear();
  launcher.destroy();
});
