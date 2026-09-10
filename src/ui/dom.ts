export function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const result = document.querySelector<T>(selector);
  if (!result) throw new Error(`缺少界面元素：${selector}`);
  return result;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character] ?? character;
  });
}

export function downloadFile(name: string, data: string | Uint8Array, mime: string): void {
  const body = typeof data === 'string' ? '\uFEFF' + data : new Uint8Array(data).buffer;
  const url = URL.createObjectURL(new Blob([body], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  // Windows filenames cannot contain ASCII controls or reserved punctuation.
  // eslint-disable-next-line no-control-regex
  link.download = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 160);
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

const GENERIC_FAILURE = '操作失败，请重试。';

/**
 * `instanceof Error` is per-realm. The panel runs in an iframe inside the learning page, and that
 * page builds its errors in the parent realm, so every message crossing the bridge tested false
 * here and collapsed into the generic text — a real cause like "原标签页已切换到其他视频" reached
 * the user as "操作失败，请重试". Reading the message off the object survives the boundary, and
 * covers DOMException (AbortError) too, which is not an Error subclass in every engine.
 */
export function errorMessage(error: unknown): string {
  const message =
    typeof error === 'object' && error !== null && 'message' in error
      ? (error as { message?: unknown }).message
      : undefined;
  return typeof message === 'string' && message.trim() ? message : GENERIC_FAILURE;
}
