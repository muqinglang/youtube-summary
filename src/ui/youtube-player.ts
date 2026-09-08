export interface PlaybackState {
  currentTime: number;
  duration: number;
  paused: boolean;
}

/** YouTube's embedded player owns playback. Only its own frame can update the local clock. */
export class YoutubePlayer {
  private ready = false;
  private sourceMatches = true;
  private attempts = 0;
  private readonly timer: number;
  private state: PlaybackState = { currentTime: 0, duration: 0, paused: true };
  private readonly receive: (event: MessageEvent) => void;
  private externalCaptions = true;
  private captionMethods = new Set<string>();
  private nativeCaptionsDisabled = false;
  private suppressNextCaptionModule = true;
  private receivedReadyEvent = false;

  constructor(
    private readonly frame: HTMLIFrameElement,
    private readonly videoId: string,
    start: number,
    private readonly onState: (state: PlaybackState) => void,
    private readonly onError: (message: string) => void,
  ) {
    this.state.currentTime = start;
    this.receive = (event) => {
      if (event.source !== frame.contentWindow || event.origin !== 'https://www.youtube.com')
        return;
      let data: unknown = event.data;
      try {
        if (typeof data === 'string') data = JSON.parse(data);
      } catch {
        return;
      }
      if (!data || typeof data !== 'object') return;
      const message = data as { event?: string; info?: unknown };
      if (!this.sourceMatches) return;
      if (message.info && typeof message.info === 'object') {
        const videoData = (message.info as Record<string, unknown>).videoData;
        if (videoData && typeof videoData === 'object') {
          const currentId = (videoData as Record<string, unknown>).video_id;
          if (typeof currentId === 'string' && currentId && currentId !== this.videoId) {
            // A recommendation can replace the video without changing the iframe or origin.
            // Keep this mismatch latched so delayed packets cannot restore the old context.
            this.sourceMatches = false;
            clearInterval(this.timer);
            this.state.paused = true;
            this.pause();
            this.onState({ ...this.state });
            this.onError(this.identityError());
            return;
          }
        }
      }
      if (
        message.event === 'onReady' ||
        message.event === 'initialDelivery' ||
        message.event === 'infoDelivery'
      ) {
        if (!this.ready) {
          this.ready = true;
          clearInterval(this.timer);
          for (const name of ['onStateChange', 'onError', 'onAutoplayBlocked', 'onApiChange'])
            this.post('addEventListener', [name]);
        }
        if (message.event === 'onReady') {
          if (this.receivedReadyEvent) {
            this.nativeCaptionsDisabled = false;
            this.suppressNextCaptionModule = this.externalCaptions;
          }
          this.receivedReadyEvent = true;
        }
        if (message.info && typeof message.info === 'object') {
          const info = message.info as Record<string, unknown>;
          if (Array.isArray(info.apiInterface))
            this.captionMethods = new Set(
              info.apiInterface.filter((name): name is string => typeof name === 'string'),
            );
          if (typeof info.currentTime === 'number' && Number.isFinite(info.currentTime))
            this.state.currentTime = Math.max(0, info.currentTime);
          if (typeof info.duration === 'number' && Number.isFinite(info.duration))
            this.state.duration = Math.max(0, info.duration);
          if (typeof info.playerState === 'number') this.state.paused = info.playerState !== 1;
          this.onState({ ...this.state });
        }
        this.applyCaptionPolicy();
      } else if (message.event === 'onApiChange') {
        // Caption modules can arrive after onReady. Consume this once so our unload
        // event cannot loop, and later manual CC choices are not continually reset.
        if (this.externalCaptions && this.suppressNextCaptionModule) {
          this.suppressNextCaptionModule = false;
          this.nativeCaptionsDisabled = false;
          this.applyCaptionPolicy();
        }
      } else if (message.event === 'onStateChange' && typeof message.info === 'number') {
        this.state.paused = message.info !== 1;
        this.onState({ ...this.state });
      } else if (message.event === 'onError') {
        const code = Number(message.info);
        this.onError(
          [101, 150].includes(code)
            ? '此视频不允许嵌入播放，请通过左上角返回 YouTube。已读取的字幕和笔记仍可使用。'
            : `YouTube 播放器暂时无法播放（${Number.isFinite(code) ? code : '未知错误'}），可返回原视频检查后重试。`,
        );
      } else if (message.event === 'onAutoplayBlocked') {
        this.onError('浏览器阻止了自动播放，请点击视频内的播放按钮。');
      }
    };
    window.addEventListener('message', this.receive);
    const url = new URL(`https://www.youtube.com/embed/${videoId}`);
    url.search = new URLSearchParams({
      enablejsapi: '1',
      origin: location.origin,
      playsinline: '1',
      rel: '0',
      cc_load_policy: '0',
      start: String(Math.floor(start)),
      widget_referrer: `https://sidenote.${chrome.runtime.id}/`,
    }).toString();
    frame.src = url.href;
    this.timer = window.setInterval(() => {
      if (++this.attempts > 60) {
        clearInterval(this.timer);
        this.onError('播放器连接较慢，请检查网络；字幕和 AI 功能可继续使用。');
        return;
      }
      frame.contentWindow?.postMessage(
        JSON.stringify({ event: 'listening', id: 'sidenote-player', channel: 'sidenote' }),
        'https://www.youtube.com',
      );
    }, 500);
  }

  private post(func: string, args: unknown[] = []) {
    this.frame.contentWindow?.postMessage(
      JSON.stringify({ event: 'command', func, args, id: 'sidenote-player', channel: 'sidenote' }),
      'https://www.youtube.com',
    );
  }
  get matchesVideo() {
    return this.sourceMatches;
  }
  /** Switch caption ownership explicitly, never once per cue or playback update. */
  setExternalCaptions(visible: boolean, reapply = false) {
    if (visible === this.externalCaptions && !reapply) return;
    this.externalCaptions = visible;
    this.suppressNextCaptionModule = visible;
    if (reapply && visible) this.nativeCaptionsDisabled = false;
    this.applyCaptionPolicy();
  }
  private applyCaptionPolicy() {
    if (!this.ready || !this.sourceMatches) return;
    const method = this.externalCaptions ? 'unloadModule' : 'loadModule';
    if (!this.captionMethods.has(method)) return;
    if (this.externalCaptions === this.nativeCaptionsDisabled) return;
    try {
      // These module methods are advertised by the live iframe's apiInterface.
      // cc_load_policy alone respects saved user preferences and cannot force CC off.
      this.post(method, ['captions']);
      this.nativeCaptionsDisabled = this.externalCaptions;
    } catch {
      // A player without a captions module must still remain playable.
    }
  }
  seek(time: number) {
    this.requireReady();
    this.post('seekTo', [Math.max(0, time), true]);
  }
  toggle() {
    this.requireReady();
    this.post(this.state.paused ? 'playVideo' : 'pauseVideo');
  }
  pause() {
    this.post('pauseVideo');
  }
  speed(rate: number) {
    this.requireReady();
    this.post('setPlaybackRate', [rate]);
  }
  private requireReady() {
    if (!this.sourceMatches) throw new Error(this.identityError());
    if (!this.ready) throw new Error('视频播放器尚未就绪，请先点击视频播放。');
  }
  private identityError() {
    return '播放器已切换到其他视频，已暂停同步。请刷新本学习页继续原视频，或从新视频重新打开旁听。';
  }
  dispose() {
    clearInterval(this.timer);
    window.removeEventListener('message', this.receive);
  }
}
