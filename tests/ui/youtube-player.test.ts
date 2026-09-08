import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { YoutubePlayer, type PlaybackState } from '../../src/ui/youtube-player';

const videoId = 'QLLuZbuTIRc';
const otherId = 'arj7oStGLkU';
const youtubeOrigin = 'https://www.youtube.com';

describe('learning player video identity', () => {
  let target: EventTarget;
  let player: YoutubePlayer;
  let playerWindow: { postMessage: ReturnType<typeof vi.fn> };
  let onState: ReturnType<typeof vi.fn<(state: PlaybackState) => void>>;
  let onError: ReturnType<typeof vi.fn<(message: string) => void>>;
  let frame: HTMLIFrameElement;

  beforeEach(() => {
    target = new EventTarget();
    vi.stubGlobal('window', Object.assign(target, { setInterval: vi.fn(() => 1) }));
    vi.stubGlobal('clearInterval', vi.fn());
    vi.stubGlobal('location', { origin: 'chrome-extension://test' });
    vi.stubGlobal('chrome', { runtime: { id: 'test' } });
    playerWindow = { postMessage: vi.fn() };
    onState = vi.fn();
    onError = vi.fn();
    frame = { contentWindow: playerWindow, src: '' } as unknown as HTMLIFrameElement;
    player = new YoutubePlayer(frame, videoId, 12, onState, onError);
  });

  afterEach(() => {
    player.dispose();
    vi.unstubAllGlobals();
  });

  function receive(data: unknown, source: unknown = playerWindow, origin = youtubeOrigin) {
    target.dispatchEvent(Object.assign(new Event('message'), { data, source, origin }));
  }

  function delivery(id: string, event = 'infoDelivery') {
    return {
      event,
      info: {
        videoData: { video_id: id },
        currentTime: 42,
        duration: 300,
        playerState: 1,
      },
    };
  }
  function captionReady() {
    const data = delivery(videoId, 'initialDelivery');
    receive({ ...data, info: { ...data.info, apiInterface: ['loadModule', 'unloadModule'] } });
  }
  function captionCommands() {
    return playerWindow.postMessage.mock.calls
      .map((call) => JSON.parse(String(call[0])))
      .filter((command) => ['loadModule', 'unloadModule'].includes(command.func));
  }

  it('disables native CC at readiness and one delayed module event without an unload loop', () => {
    expect(new URL(frame.src).searchParams.get('cc_load_policy')).toBe('0');
    captionReady();
    receive({ event: 'onReady' });
    receive({ event: 'onApiChange' });
    receive({ event: 'onApiChange' });
    receive(delivery(videoId));
    player.seek(80);
    player.setExternalCaptions(true);
    expect(captionCommands().map((command) => [command.func, command.args])).toEqual([
      ['unloadModule', ['captions']],
      ['unloadModule', ['captions']],
    ]);
  });
  it('allows later manual CC changes and reasserts external captions only on explicit request', () => {
    captionReady();
    receive({ event: 'onApiChange' });
    playerWindow.postMessage.mockClear();
    receive({ event: 'onApiChange' });
    expect(captionCommands()).toHaveLength(0);
    player.setExternalCaptions(true, true);
    expect(captionCommands()[0]).toMatchObject({ func: 'unloadModule', args: ['captions'] });
  });
  it('restores native captions only when explicitly switching away from external captions', () => {
    captionReady();
    playerWindow.postMessage.mockClear();
    player.setExternalCaptions(false);
    player.setExternalCaptions(false);
    receive({ event: 'onApiChange' });
    expect(captionCommands()).toHaveLength(1);
    expect(captionCommands()[0]).toMatchObject({ func: 'loadModule', args: ['captions'] });
    player.setExternalCaptions(true);
    expect(captionCommands()[1]).toMatchObject({ func: 'unloadModule' });
  });
  it('does not send unsupported module commands or act after video identity changes', () => {
    receive(delivery(videoId));
    receive({ event: 'onApiChange' });
    expect(captionCommands()).toEqual([]);
    captionReady();
    receive(delivery(otherId));
    playerWindow.postMessage.mockClear();
    player.setExternalCaptions(false);
    receive({ event: 'onApiChange' });
    expect(playerWindow.postMessage).not.toHaveBeenCalled();
  });
  it('reapplies the caption policy when a ready player reloads', () => {
    captionReady();
    receive({ event: 'onReady' });
    receive({ event: 'onApiChange' });
    playerWindow.postMessage.mockClear();
    receive({ event: 'onReady' });
    expect(captionCommands()[0]).toMatchObject({ func: 'unloadModule' });
  });

  it.each(['initialDelivery', 'infoDelivery'])(
    'accepts %s for this video and seeks the same player',
    (event) => {
      receive(JSON.stringify(delivery(videoId, event)));
      expect(player.matchesVideo).toBe(true);
      expect(onState).toHaveBeenLastCalledWith({ currentTime: 42, duration: 300, paused: false });
      player.seek(120);
      expect(playerWindow.postMessage).toHaveBeenLastCalledWith(
        JSON.stringify({
          event: 'command',
          func: 'seekTo',
          args: [120, true],
          id: 'sidenote-player',
          channel: 'sidenote',
        }),
        youtubeOrigin,
      );
      expect(onError).not.toHaveBeenCalled();
    },
  );

  it('pauses a replacement video while retaining the original caption clock', () => {
    receive(delivery(videoId));
    playerWindow.postMessage.mockClear();
    receive({
      event: 'infoDelivery',
      info: {
        videoData: { video_id: otherId },
        currentTime: 5,
        duration: 900,
        playerState: 1,
      },
    });

    expect(player.matchesVideo).toBe(false);
    expect(onState).toHaveBeenLastCalledWith({ currentTime: 42, duration: 300, paused: true });
    expect(onError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('切换到其他视频'));
    expect(playerWindow.postMessage).toHaveBeenCalledOnce();
    expect(JSON.parse(String(playerWindow.postMessage.mock.calls[0]?.[0]))).toMatchObject({
      func: 'pauseVideo',
    });
    playerWindow.postMessage.mockClear();
    expect(() => player.seek(150)).toThrow('切换到其他视频');
    expect(() => player.toggle()).toThrow('切换到其他视频');
    expect(() => player.speed(2)).toThrow('切换到其他视频');
    expect(playerWindow.postMessage).not.toHaveBeenCalled();
  });

  it('does not let late readiness, id-less state or old matching packets unlock a mismatch', () => {
    receive(delivery(otherId, 'initialDelivery'));
    onState.mockClear();
    receive({ event: 'onReady' });
    receive({ event: 'onStateChange', info: 1 });
    receive({ event: 'infoDelivery', info: { currentTime: 80, playerState: 1 } });
    receive(delivery(videoId));

    expect(player.matchesVideo).toBe(false);
    expect(onState).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(() => player.seek(150)).toThrow('切换到其他视频');
  });

  it('ignores video identity changes from an unrelated frame or origin', () => {
    receive(delivery(videoId));
    onState.mockClear();
    receive(delivery(otherId), {});
    receive(delivery(otherId), playerWindow, 'https://example.com');

    expect(player.matchesVideo).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    expect(onState).not.toHaveBeenCalled();
    expect(() => player.seek(150)).not.toThrow();
  });
});
