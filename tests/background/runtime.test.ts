import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Reply, RuntimeRequest, VideoInfo } from '../../src/shared/types';

type MessageListener = Parameters<typeof chrome.runtime.onMessage.addListener>[0];
type ConnectListener = Parameters<typeof chrome.runtime.onConnect.addListener>[0];
const EXTENSION_ID = 'test-extension';
const EXTENSION_URL = `chrome-extension://${EXTENSION_ID}/panel.html`;

function storageArea() {
  const values: Record<string, unknown> = {};
  return {
    values,
    get: vi.fn(async (keys: string | string[]) =>
      Object.fromEntries(
        (typeof keys === 'string' ? [keys] : keys).map((key) => [key, values[key]]),
      ),
    ),
    set: vi.fn(async (data: Record<string, unknown>) => {
      Object.assign(values, data);
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of typeof keys === 'string' ? [keys] : keys) delete values[key];
    }),
    setAccessLevel: vi.fn(async () => undefined),
  };
}

describe('background runtime authorization', () => {
  let handler: MessageListener;
  let connect: ConnectListener;
  let local: ReturnType<typeof storageArea>;
  let session: ReturnType<typeof storageArea>;
  let sendMessage: ReturnType<typeof vi.fn>;
  let tabSendMessage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    local = storageArea();
    session = storageArea();
    sendMessage = vi.fn(async () => undefined);
    tabSendMessage = vi.fn(async () => ({ ok: true, data: { id: 'video1' } }));
    vi.stubGlobal('chrome', {
      runtime: {
        id: EXTENSION_ID,
        getURL: (path: string) => `chrome-extension://${EXTENSION_ID}/${path}`,
        onMessage: {
          addListener: (listener: MessageListener) => {
            handler = listener;
          },
        },
        onConnect: {
          addListener: (listener: ConnectListener) => {
            connect = listener;
          },
        },
        sendMessage,
      },
      storage: { local, session },
      permissions: { contains: vi.fn(async () => true) },
      tabs: {
        get: vi.fn(async (id: number) => ({
          id,
          url: id === 1 ? 'https://www.youtube.com/watch?v=video1' : 'https://unrelated.example/',
        })),
        sendMessage: tabSendMessage,
        create: vi.fn(async () => ({ id: 3 })),
      },
      action: { onClicked: { addListener: vi.fn() }, setBadgeText: vi.fn(), setTitle: vi.fn() },
    });
    await import('../../src/background/index');
  });

  const extensionSender = (): chrome.runtime.MessageSender => ({
    id: EXTENSION_ID,
    url: EXTENSION_URL,
  });
  const contentSender = (): chrome.runtime.MessageSender => ({
    id: EXTENSION_ID,
    url: 'https://www.youtube.com/watch?v=video1',
    tab: { id: 1 } as chrome.tabs.Tab,
  });
  const request = <T>(message: RuntimeRequest, sender = extensionSender()) =>
    new Promise<Reply<T>>((resolve) => {
      handler(message, sender, resolve);
    });

  it('allows content scripts to obtain only their own tab identity', async () => {
    expect(await request({ type: 'tab:id' }, contentSender())).toEqual({ ok: true, data: 1 });
    const denied = await request({ type: 'settings:get' }, contentSender());
    expect(denied.ok).toBe(false);
    expect(JSON.stringify(denied)).toContain('扩展面板');
    const badBootstrap = await request(
      { type: 'tab:id' },
      { ...contentSender(), url: 'https://attacker.example/' },
    );
    expect(badBootstrap.ok).toBe(false);
  });

  it('rejects content-script settings writes and AI requests', async () => {
    expect(
      (
        await request(
          { type: 'settings:save', settings: { apiKey: 'injected-key' } },
          contentSender(),
        )
      ).ok,
    ).toBe(false);
    expect((await request({ type: 'ai:test' }, contentSender())).ok).toBe(false);
    expect(JSON.stringify(local.values)).not.toContain('injected-key');
    expect(JSON.stringify(session.values)).not.toContain('injected-key');
  });

  it('never returns saved credentials from settings get/save replies', async () => {
    const saved = await request({
      type: 'settings:save',
      settings: { apiKey: 'secret-test-key', model: 'gpt-4.1-mini' },
    });
    expect(saved.ok).toBe(true);
    expect(JSON.stringify(saved)).not.toContain('secret-test-key');
    const result = await request({ type: 'settings:get' });
    expect(JSON.stringify(result)).not.toContain('secret-test-key');
    expect(result).toMatchObject({ ok: true, data: { hasApiKey: true } });
  });

  it('ignores messages from other extensions entirely', () => {
    const response = vi.fn();
    expect(
      handler({ type: 'settings:get' }, { id: 'foreign-extension', url: EXTENSION_URL }, response),
    ).toBe(false);
    expect(response).not.toHaveBeenCalled();
  });

  it('restricts player and transcript relays to YouTube tabs', async () => {
    expect(await request({ type: 'video:get', tabId: 1 })).toEqual({
      ok: true,
      data: { id: 'video1' },
    });
    expect((await request({ type: 'video:get', tabId: 2 })).ok).toBe(false);
    expect(
      (await request({ type: 'player:command', tabId: 1, command: { action: 'seek', time: -1 } }))
        .ok,
    ).toBe(false);
    expect(tabSendMessage).toHaveBeenCalledTimes(1);
  });

  it('rewrites content events to actual sender tab and ignores rebroadcast events', () => {
    const video: VideoInfo = {
      id: 'video1',
      title: 'Video',
      author: '',
      url: 'https://www.youtube.com/watch?v=video1',
      duration: 20,
      currentTime: 2,
      paused: false,
      tracks: [],
    };
    handler({ type: 'video:update', tabId: 999, video }, contentSender(), vi.fn());
    expect(sendMessage).toHaveBeenCalledWith({ type: 'video:update', tabId: 1, video });
    handler({ type: 'video:update', tabId: 1, video }, extensionSender(), vi.fn());
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('disconnects untrusted ports before accepting AI jobs', () => {
    const disconnect = vi.fn();
    const addListener = vi.fn();
    connect({
      name: 'sidenote-panel',
      sender: contentSender(),
      disconnect,
      onMessage: { addListener },
    } as unknown as chrome.runtime.Port);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(addListener).not.toHaveBeenCalled();
  });
});
