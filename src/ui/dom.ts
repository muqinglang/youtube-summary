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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请重试。';
}
