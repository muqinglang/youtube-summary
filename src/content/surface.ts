/** A small page entry; the video and learning tools live in a separate extension tab. */
export class LearningLauncher {
  private readonly host = document.createElement('div');
  private readonly button = document.createElement('button');

  constructor(onOpen: () => void) {
    this.host.id = 'sidenote-launcher';
    const root = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; display: inline-flex; flex: 0 0 auto; align-self: center;
        margin-inline-end: 8px; vertical-align: middle; }
      :host([hidden]) { display: none; }
      button { display: inline-flex; align-items: center; justify-content: center; gap: 7px;
        height: 36px; box-sizing: border-box; padding: 0 13px; border: 1px solid #e1b447;
        border-radius: 18px; background: #f4ca64; color: #211b0f;
        font: 600 14px/1 system-ui, 'Microsoft YaHei', sans-serif; white-space: nowrap; cursor: pointer; }
      button::before { content: 's.'; font-size: 20px; font-weight: 800; }
      button:hover { background: #ffdc82; }
      button:disabled { opacity: .65; cursor: wait; }
      button:focus-visible { outline: 2px solid #987013; outline-offset: 3px; }
    `;
    this.button.type = 'button';
    this.button.textContent = '旁听 AI';
    this.button.title = '在独立学习页打开视频';
    this.button.setAttribute('aria-label', '打开旁听学习页面');
    this.button.addEventListener('click', onOpen);
    root.append(style, this.button);
  }

  attach(available: boolean) {
    this.host.hidden = !available;
    if (!available) return;
    const actions = [
      ...document.querySelectorAll<HTMLElement>(
        'ytd-watch-metadata #actions #top-level-buttons-computed, #info #menu-container #top-level-buttons-computed',
      ),
    ].find((element) => element.getClientRects().length && !element.closest('[hidden]'));
    if (!actions) {
      this.host.remove();
      return;
    }
    if (this.host.parentElement === actions) return;
    let anchor = actions.querySelector(
      'segmented-like-dislike-button-view-model, ytd-segmented-like-dislike-button-renderer',
    );
    while (anchor?.parentElement && anchor.parentElement !== actions) anchor = anchor.parentElement;
    if (anchor) actions.insertBefore(this.host, anchor);
    else actions.prepend(this.host);
  }

  setBusy(busy: boolean) {
    this.button.disabled = busy;
  }
  reportError(message: string) {
    this.button.title = message;
    this.button.textContent = '旁听 · 请重试';
  }
  destroy() {
    this.host.remove();
  }
}
