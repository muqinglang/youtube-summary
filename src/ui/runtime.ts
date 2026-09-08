import type { AiRequest, AiResult, JobProgress, Reply, RuntimeRequest } from '../shared/types';

export async function send<T>(message: RuntimeRequest): Promise<T> {
  if (
    new URLSearchParams(location.search).has('workspace') &&
    window.parent !== window &&
    ['video:get', 'transcript:get', 'player:command'].includes(message.type)
  ) {
    const parent = window.parent as Window & {
      sidenoteLearning?: { request: (request: RuntimeRequest) => Promise<unknown> };
    };
    if (!parent.sidenoteLearning) throw new Error('学习页面连接未就绪，请刷新此页面。');
    return (await parent.sidenoteLearning.request(message)) as T;
  }
  const reply = (await chrome.runtime.sendMessage(message)) as Reply<T> | undefined;
  if (!reply) throw new Error('扩展连接已断开，请刷新 YouTube 页面。');
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}

interface PortEvent {
  type: string;
  jobId?: string;
  result?: AiResult;
  error?: string;
  progress?: JobProgress;
}

/** One port per task. Heartbeats exist only during work; disconnect cancels worker-side work. */
export function runJob(
  request: AiRequest,
  signal: AbortSignal,
  onProgress: (progress: JobProgress) => void,
): Promise<AiResult> {
  if (signal.aborted) return Promise.reject(new DOMException('已取消', 'AbortError'));
  return new Promise((resolve, reject) => {
    const jobId = crypto.randomUUID();
    const port = chrome.runtime.connect({ name: 'sidenote-panel' });
    let settled = false;
    const heartbeat = window.setInterval(() => port.postMessage({ type: 'heartbeat' }), 20_000);

    function finish(error?: Error, result?: AiResult) {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      signal.removeEventListener('abort', cancel);
      port.onMessage.removeListener(receive);
      port.onDisconnect.removeListener(disconnect);
      port.disconnect();
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new Error('AI 未返回结果。'));
    }

    function receive(event: PortEvent) {
      if (event.type === 'ai:progress' && event.progress?.jobId === jobId) {
        onProgress(event.progress);
      } else if (event.jobId === jobId && event.type === 'ai:result') {
        finish(undefined, event.result);
      } else if (event.jobId === jobId && event.type === 'ai:error') {
        finish(new Error(event.error || 'AI 处理失败，请重试。'));
      }
    }

    function disconnect() {
      // Read lastError so Chrome does not emit an unchecked runtime error.
      const detail = chrome.runtime.lastError?.message;
      finish(new Error(detail || '处理连接中断，请重试。'));
    }

    function cancel() {
      port.postMessage({ type: 'ai:cancel', jobId });
      finish(new DOMException('已取消', 'AbortError'));
    }

    port.onMessage.addListener(receive);
    port.onDisconnect.addListener(disconnect);
    signal.addEventListener('abort', cancel, { once: true });
    port.postMessage({ type: 'ai:run', jobId, request });
  });
}
