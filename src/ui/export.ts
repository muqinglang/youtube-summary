import '../shared/zod-setup';
import { buildPrintHtml } from '../core/exports';
import type { ExportDocument } from '../shared/types';
import { element, errorMessage } from './dom';

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
  // The browser print dialog is the only way to produce a PDF from an extension page: a silent
  // download would need a bundled PDF engine plus an embedded CJK font. Say so rather than
  // leaving people waiting for a file that never arrives.
  element('#pdf-button').addEventListener('click', () => {
    element('#save-hint').hidden = false;
    window.print();
  });
}

void initialize().catch((error: unknown) => {
  element('#document').textContent = errorMessage(error);
  element<HTMLButtonElement>('#print-button').disabled = true;
  element<HTMLButtonElement>('#pdf-button').disabled = true;
});
