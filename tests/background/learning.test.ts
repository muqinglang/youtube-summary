import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Reply, VideoInfo } from '../../src/shared/types';

type MessageListener = Parameters<typeof chrome.runtime.onMessage.addListener>[0];
const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const videoId = 'QLLuZbuTIRc';
const sourceUrl = `https://www.youtube.com/watch?v=${videoId}`;
const video: VideoInfo = {
  id: videoId,
  title: 'Video',
  author: 'Author',
  url: sourceUrl,
  duration: 300,
  currentTime: 42.5,
  paused: false,
  tracks: [],
};

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

describe('independent learning page runtime', () => {
  let handler: MessageListener;
  let session: ReturnType<typeof storageArea>;
  let tabs: Map<number, chrome.tabs.Tab>;
  let snapshots: Map<number, VideoInfo>;
  let updateRules: ReturnType<typeof vi.fn>;
  let createTab: ReturnType<typeof vi.fn>;
  let updateTab: ReturnType<typeof vi.fn>;
  let sendTab: ReturnType<typeof vi.fn>;
  let getContexts: ReturnType<typeof vi.fn>;
  let nextTabId: number;

  const sender = (tabId = 1, url = sourceUrl): chrome.runtime.MessageSender => ({
    id: extensionId,
    url,
    frameId: 0,
    tab: { id: tabId } as chrome.tabs.Tab,
  });
  const extensionSender = (): chrome.runtime.MessageSender => ({
    id: extensionId,
    url: `chrome-extension://${extensionId}/learn.html`,
  });
  const learningContext = (
    overrides: Partial<chrome.runtime.ExtensionContext> = {},
  ): chrome.runtime.ExtensionContext => ({
    contextId: 'learning-context',
    contextType: 'TAB',
    documentUrl: `chrome-extension://${extensionId}/learn.html?tabId=1&videoId=${videoId}`,
    frameId: 0,
    tabId: 100,
    windowId: 1,
    incognito: false,
    ...overrides,
  });
  const dispatch = (message: unknown, from = sender()): Promise<Reply<unknown>> =>
    new Promise((resolve) => {
      handler(message, from, resolve);
    });
  const open = (from = sender()) => dispatch({ type: 'learning:open' }, from);

  beforeEach(async () => {
    vi.resetModules();
    session = storageArea();
    tabs = new Map([[1, { id: 1, url: sourceUrl } as chrome.tabs.Tab]]);
    snapshots = new Map([[1, { ...video }]]);
    nextTabId = 100;
    updateRules = vi.fn(async () => undefined);
    getContexts = vi.fn(async () => [] as chrome.runtime.ExtensionContext[]);
    createTab = vi.fn(async (properties: chrome.tabs.CreateProperties) => {
      const tab = {
        id: nextTabId++,
        url: properties.url,
        active: properties.active,
      } as chrome.tabs.Tab;
      tabs.set(tab.id!, tab);
      return tab;
    });
    updateTab = vi.fn(async (id: number, properties: chrome.tabs.UpdateProperties) => {
      const tab = tabs.get(id);
      if (!tab) throw new Error('Missing tab');
      Object.assign(tab, properties);
      return tab;
    });
    sendTab = vi.fn(async (id: number, message: { type: string }) =>
      message.type === 'video:get'
        ? { ok: true, data: snapshots.get(id) }
        : { ok: true, data: null },
    );
    vi.stubGlobal('chrome', {
      runtime: {
        id: extensionId,
        getURL: (path: string) => `chrome-extension://${extensionId}/${path}`,
        getContexts,
        onMessage: {
          addListener: (listener: MessageListener) => {
            handler = listener;
          },
        },
        onConnect: { addListener: vi.fn() },
        sendMessage: vi.fn(async () => undefined),
      },
      storage: { session, local: storageArea() },
      declarativeNetRequest: {
        updateDynamicRules: updateRules,
        RuleActionType: { MODIFY_HEADERS: 'modifyHeaders' },
        HeaderOperation: { SET: 'set' },
        ResourceType: { SUB_FRAME: 'sub_frame' },
      },
      tabs: {
        get: vi.fn(async (id: number) => {
          const tab = tabs.get(id);
          if (!tab) throw new Error('Missing tab');
          return tab;
        }),
        create: createTab,
        update: updateTab,
        sendMessage: sendTab,
      },
      action: { onClicked: { addListener: vi.fn() }, setBadgeText: vi.fn(), setTitle: vi.fn() },
    });
    await import('../../src/background/index');
  });

  it('opens only its own learn page with the verified source and native playback time', async () => {
    expect(await open()).toEqual({ ok: true, data: { tabId: 100, reused: false } });
    expect(createTab).toHaveBeenCalledWith({
      url: `chrome-extension://${extensionId}/learn.html?tabId=1&videoId=${videoId}&start=42.5`,
      active: true,
    });
    expect(session.values[`learning-session:${videoId}`]).toEqual({ video, sourceTabId: 1 });
    expect(sendTab).toHaveBeenCalledWith(1, {
      type: 'player:command',
      tabId: 1,
      command: { action: 'pause' },
    });
  });

  it.each([
    () => extensionSender(),
    () => sender(1, 'https://attacker.example/'),
    () => sender(1, 'https://www.youtube.com/results?search_query=video'),
    () => sender(1, 'https://www.youtube.com/watch?v=invalid'),
    () => ({ ...sender(), frameId: 4 }),
  ])('rejects unauthorized or non-video callers', async (makeSender) => {
    expect((await open(makeSender())).ok).toBe(false);
    expect(createTab).not.toHaveBeenCalled();
  });

  it('ignores caller-supplied target fields and verifies the real browser tab', async () => {
    expect(
      (await dispatch({ type: 'learning:open', tabId: 999, url: 'https://attacker.example/' })).ok,
    ).toBe(true);
    expect(createTab.mock.calls[0]?.[0].url).toContain('tabId=1');
    tabs.set(1, { id: 1, url: 'https://www.youtube.com/watch?v=abcdefghijk' } as chrome.tabs.Tab);
    expect((await open()).ok).toBe(false);
    expect(createTab).toHaveBeenCalledOnce();
  });

  it('rejects stale or mismatched native video metadata', async () => {
    snapshots.set(1, { ...video, id: 'abcdefghijk' });
    expect((await open()).ok).toBe(false);
    snapshots.set(1, { ...video, url: 'https://attacker.example/' });
    expect((await open()).ok).toBe(false);
    expect(createTab).not.toHaveBeenCalled();
  });

  it('limits Referer modification to our extension-initiated YouTube embed frames', () => {
    expect(updateRules).toHaveBeenCalledWith({
      removeRuleIds: [23001],
      addRules: [
        {
          id: 23001,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'Referer', operation: 'set', value: `https://sidenote.${extensionId}/` },
            ],
          },
          condition: {
            initiatorDomains: [extensionId],
            urlFilter: '|https://www.youtube.com/embed/',
            resourceTypes: ['sub_frame'],
          },
        },
      ],
    });
  });

  it('reuses the existing learning page without reloading and serializes repeated clicks', async () => {
    const [first, second] = await Promise.all([open(), open()]);
    expect(first).toEqual({ ok: true, data: { tabId: 100, reused: false } });
    expect(second).toEqual({ ok: true, data: { tabId: 100, reused: true } });
    expect(createTab).toHaveBeenCalledOnce();
    expect(updateTab).toHaveBeenCalledWith(100, { active: true });
    expect(getContexts).not.toHaveBeenCalled();
  });

  it('reuses our own top-level context when Chrome hides its tab URL, including after worker restart', async () => {
    await open();
    tabs.set(100, { id: 100 } as chrome.tabs.Tab);
    getContexts.mockResolvedValue([learningContext()]);
    vi.resetModules();
    await import('../../src/background/index');

    expect(await open()).toEqual({ ok: true, data: { tabId: 100, reused: true } });
    expect(getContexts).toHaveBeenCalledWith({
      contextTypes: ['TAB'],
      tabIds: [100],
      frameIds: [0],
    });
    expect(createTab).toHaveBeenCalledOnce();
    expect(updateTab).toHaveBeenCalledWith(100, { active: true });
  });

  it.each<Partial<chrome.runtime.ExtensionContext>>([
    { documentUrl: `chrome-extension://${extensionId}/learn.html?tabId=1&videoId=abcdefghijk` },
    { documentUrl: `chrome-extension://${extensionId}/panel.html?tabId=1&videoId=${videoId}` },
    { documentUrl: `chrome-extension://other-extension/learn.html?tabId=1&videoId=${videoId}` },
    { documentUrl: `https://attacker.example/learn.html?tabId=1&videoId=${videoId}` },
    { tabId: 999 },
    { frameId: 1 },
    { contextType: 'POPUP' },
  ])('rejects an unrelated context when the saved tab URL is hidden: %j', async (overrides) => {
    await open();
    tabs.set(100, { id: 100 } as chrome.tabs.Tab);
    getContexts.mockResolvedValue([learningContext(overrides)]);

    expect(await open()).toEqual({ ok: true, data: { tabId: 101, reused: false } });
    expect(updateTab).not.toHaveBeenCalled();
  });

  it('does not use a stale learning context when the tab has a visible pending navigation', async () => {
    await open();
    tabs.set(100, { id: 100, pendingUrl: 'https://attacker.example/' } as chrome.tabs.Tab);
    getContexts.mockResolvedValue([learningContext()]);

    expect(await open()).toEqual({ ok: true, data: { tabId: 101, reused: false } });
    expect(getContexts).not.toHaveBeenCalled();
    expect(updateTab).not.toHaveBeenCalled();
  });

  it('opens a fresh learning page if the hidden tab context disappears during lookup', async () => {
    await open();
    tabs.set(100, { id: 100 } as chrome.tabs.Tab);
    getContexts.mockRejectedValue(new Error('Context disappeared'));

    expect(await open()).toEqual({ ok: true, data: { tabId: 101, reused: false } });
    expect(updateTab).not.toHaveBeenCalled();
  });

  it('retains page deduplication across service worker restarts', async () => {
    await open();
    vi.resetModules();
    await import('../../src/background/index');
    expect(await open()).toEqual({ ok: true, data: { tabId: 100, reused: true } });
    expect(createTab).toHaveBeenCalledOnce();
  });

  it('never reuses a tab that has navigated away from this extension learning page', async () => {
    await open();
    tabs.get(100)!.url = 'https://attacker.example/learn.html';
    expect(await open()).toEqual({ ok: true, data: { tabId: 101, reused: false } });
    expect(updateTab).not.toHaveBeenCalled();
  });

  it('recovers when the saved learning tab closes during activation', async () => {
    await open();
    updateTab.mockRejectedValueOnce(new Error('Tab just closed'));
    expect(await open()).toEqual({ ok: true, data: { tabId: 101, reused: false } });
    expect(createTab).toHaveBeenCalledTimes(2);
  });

  it('rebinds an existing learning page if its original source has gone away', async () => {
    await open();
    tabs.delete(1);
    tabs.set(2, { id: 2, url: sourceUrl } as chrome.tabs.Tab);
    snapshots.set(2, { ...video, currentTime: 81 });
    expect(await open(sender(2))).toEqual({ ok: true, data: { tabId: 100, reused: true } });
    expect(updateTab).toHaveBeenCalledWith(100, {
      url: `chrome-extension://${extensionId}/learn.html?tabId=2&videoId=${videoId}&start=81`,
      active: true,
    });
    expect(session.values[`learning-session:${videoId}`]).toEqual({
      video: { ...video, currentTime: 81 },
      sourceTabId: 2,
    });
    expect(createTab).toHaveBeenCalledOnce();
  });

  it('does not block opening when source playback cannot be paused', async () => {
    sendTab.mockImplementation(async (id: number, message: { type: string }) => {
      if (message.type === 'player:command') throw new Error('Cannot pause');
      return { ok: true, data: snapshots.get(id) };
    });
    expect((await open()).ok).toBe(true);
  });

  it('keeps a failed embed rule initialization isolated and retryable', async () => {
    vi.resetModules();
    updateRules.mockRejectedValue(new Error('Rule denied'));
    await import('../../src/background/index');
    expect((await dispatch({ type: 'settings:get' }, extensionSender())).ok).toBe(true);
    expect((await open()).ok).toBe(false);
    expect(createTab).not.toHaveBeenCalled();
    updateRules.mockResolvedValue(undefined);
    expect((await open()).ok).toBe(true);
  });

  it('bounds source session retention without closing unrelated learning pages', async () => {
    for (let index = 0; index < 11; index++) {
      const id = `video${String(index).padStart(6, '0')}`;
      const url = `https://www.youtube.com/watch?v=${id}`;
      tabs.set(1, { id: 1, url } as chrome.tabs.Tab);
      snapshots.set(1, { ...video, id, url });
      expect((await open(sender(1, url))).ok).toBe(true);
      session.values[`learning-transcript:${id}`] = { videoId: id, cues: [] };
    }
    expect(
      Object.keys(session.values).filter((key) => key.startsWith('learning-session:')),
    ).toHaveLength(10);
    expect(session.values['learning-session:video000000']).toBeUndefined();
    expect(session.values['learning-transcript:video000000']).toBeUndefined();
    expect(
      Object.keys(session.values).filter((key) => key.startsWith('learning-transcript:')),
    ).toHaveLength(10);
    expect(session.values['learning:tabs']).toHaveLength(10);
    expect(createTab).toHaveBeenCalledTimes(11);
  });
});
