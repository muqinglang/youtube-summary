import '../shared/zod-setup';
import { buildPrintHtml } from '../core/exports';
import type { ExportDocument } from '../shared/types';
import { downloadFile, element, errorMessage } from './dom';

async function initialize(): Promise<void> {
  const id = new URLSearchParams(location.search).get('id');
  if (!id || !/^[\da-f-]{36}$/i.test(id)) throw new Error('导出链接无效，请从学习面板重新导出。');
  const key = `export:${id}`;
  const doc = (await chrome.storage.session.get(key))[key] as ExportDocument | undefined;
  if (!doc) throw new Error('导出内容已过期，请回到视频重新导出。');
  const html = new DOMParser().parseFromString(buildPrintHtml(doc), 'text/html');
  html.querySelectorAll('style').forEach((style) => document.head.append(style));
  element('#document').replaceChildren(...html.body.childNodes);
  document.title = doc.summary.title;
  element('#print-button').addEventListener('click', () => window.print());
  // A silent PDF would need a bundled PDF engine plus an embedded CJK font; this standalone
  // HTML opens offline anywhere and can still be printed to PDF from the file itself.
  element('#download-button').addEventListener('click', () => {
    downloadFile(`${doc.summary.title}.html`, buildPrintHtml(doc), 'text/html;charset=utf-8');
  });
}

void initialize().catch((error: unknown) => {
  element('#document').textContent = errorMessage(error);
  element<HTMLButtonElement>('#print-button').disabled = true;
  element<HTMLButtonElement>('#download-button').disabled = true;
});
