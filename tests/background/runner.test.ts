import { describe, expect, it, vi } from 'vitest';
import { HostedClient } from '../../src/background/hosted';
import { createRunner } from '../../src/background/runner';
import { DEFAULT_SETTINGS } from '../../src/background/settings';
import type { AiRequest, Settings } from '../../src/shared/types';

const SERVER = 'http://localhost:8787';
const hosted: Settings = {
  ...DEFAULT_SETTINGS,
  mode: 'hosted',
  serverUrl: SERVER,
  sessionToken: 'session-token',
  accountEmail: 'reader@example.com',
};

const request: AiRequest = {
  task: 'outline',
  video: {
    id: 'video1',
    title: 'Test',
    author: 'Author',
    url: 'https://www.youtube.com/watch?v=video1',
    duration: 100,
    currentTime: 0,
    paused: true,
    tracks: [],
  },
  transcript: {
    videoId: 'video1',
    language: 'en',
    source: 'youtube',
    coverage: 'complete',
    cues: [{ id: 'a', start: 0, end: 2, text: 'First idea.' }],
  },
  language: '简体中文',
};

const OUTLINE = { task: 'outline', outline: { sections: [{ title: 'Intro', start: 0 }] } };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function client(fetcher: typeof fetch, token = 'session-token') {
  return new HostedClient(SERVER, token, {
    fetch: fetcher,
    permissionCheck: async () => true,
    pollIntervalMs: 1,
  });
}

const signal = () => new AbortController().signal;

describe('run mode selection', () => {
  it('routes by mode without the caller knowing which side runs the pipeline', () => {
    // Both shapes satisfy the same interface; nothing above this line branches on mode.
    expect(typeof createRunner(DEFAULT_SETTINGS).run).toBe('function');
    expect(typeof createRunner(hosted).run).toBe('function');
    expect(typeof createRunner(hosted).test).toBe('function');
  });
});

describe('hosted client', () => {
  it('returns a cached artifact without polling for a job', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json({ cached: true, result: OUTLINE }));
    const progress = vi.fn();
    await expect(client(fetcher).run(request, signal(), progress)).resolves.toEqual(OUTLINE);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(progress).not.toHaveBeenCalled();
  });

  it('polls a queued job to completion and forwards its progress', async () => {
    const responses = [
      json({ cached: false, jobId: 'job-1' }, 202),
      json({
        status: 'running',
        progress: { completed: 1, total: 4, label: '正在分析字幕 1 / 4' },
      }),
      json({ status: 'done', result: OUTLINE }),
    ];
    const fetcher = vi.fn<typeof fetch>(async () => responses.shift()!);
    const progress = vi.fn();
    await expect(client(fetcher).run(request, signal(), progress)).resolves.toEqual(OUTLINE);
    expect(progress).toHaveBeenCalledWith({ completed: 1, total: 4, label: '正在分析字幕 1 / 4' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`${SERVER}/v1/jobs`);
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer session-token');
  });

  it('tells the server to stop when the user cancels, so quota is not spent on dead work', async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith('/v1/jobs')) return json({ cached: false, jobId: 'job-1' }, 202);
      if (url.endsWith('/cancel')) return json({ cancelled: true });
      controller.abort();
      return json({ status: 'running' });
    });
    await expect(
      client(fetcher).run(request, controller.signal, () => undefined),
    ).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen.some((url) => url.endsWith('/v1/jobs/job-1/cancel'))).toBe(true);
  });

  it('surfaces the reason the server gave rather than a generic failure', async () => {
    const quota = json(
      { error: '今日额度已用完，可在设置中改用自己的 API Key 继续。', quotaExhausted: true },
      402,
    );
    await expect(client(async () => quota).run(request, signal(), () => undefined)).rejects.toThrow(
      'API Key',
    );
    const expired = json({ error: '登录状态已失效，请重新登录。' }, 401);
    await expect(client(async () => expired).me(signal())).rejects.toThrow('重新登录');
  });

  it('refuses a server outside the allow-list before any request leaves', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const rogue = new HostedClient('https://evil.example', 'token', {
      fetch: fetcher,
      permissionCheck: async () => true,
    });
    await expect(rogue.me(signal())).rejects.toThrow('地址无效');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses to send a request the user has not granted host access for', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const ungranted = new HostedClient(SERVER, 'token', {
      fetch: fetcher,
      permissionCheck: async () => false,
    });
    await expect(ungranted.me(signal())).rejects.toThrow('尚未授权');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not send an authenticated request without a session', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(client(fetcher, '').me(signal())).rejects.toThrow('请先登录');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
