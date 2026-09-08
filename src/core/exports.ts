import { strToU8, zipSync } from 'fflate';
import type { ExportDocument, MindMapNode, Summary } from '../shared/types';
import { formatTime } from './transcript';

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );
}

function escapeMarkdown(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_{}[\]()#+.!|~-]/g, '\\$&')
    .replace(/\r?\n/g, ' ');
}

function sourceUrl(doc: ExportDocument, start?: number): string | undefined {
  let id = doc.video.id;
  if (!/^[\w-]{11}$/.test(id)) {
    try {
      const url = new URL(doc.video.url);
      if (
        url.protocol !== 'https:' ||
        !['www.youtube.com', 'youtube.com', 'm.youtube.com', 'youtu.be'].includes(url.hostname)
      )
        return;
      id = url.hostname === 'youtu.be' ? url.pathname.slice(1) : (url.searchParams.get('v') ?? '');
    } catch {
      return;
    }
  }
  if (!/^[\w-]{11}$/.test(id)) return;
  const url = new URL('https://www.youtube.com/watch');
  url.searchParams.set('v', id);
  if (validTime(start)) url.searchParams.set('t', `${Math.floor(start)}s`);
  return url.href;
}

function validTime(time: number | undefined): time is number {
  return typeof time === 'number' && Number.isFinite(time) && time >= 0 && time <= 604_800;
}

function validateDocument(doc: ExportDocument): void {
  if (
    !doc?.video ||
    !doc.summary ||
    typeof doc.prompt !== 'string' ||
    typeof doc.createdAt !== 'string'
  )
    throw new Error('导出文档不完整。');
  const summary = doc.summary;
  const values: unknown[] = [
    doc.video.title,
    doc.video.author,
    doc.video.id,
    doc.video.url,
    summary.title,
    summary.overview,
    doc.prompt,
  ];
  if (
    !Array.isArray(summary.sections) ||
    !Array.isArray(summary.takeaways) ||
    summary.sections.length > 1000 ||
    summary.takeaways.length > 1000
  )
    throw new Error('总结章节无效或过多。');
  values.push(...summary.takeaways);
  for (const section of summary.sections) {
    if (
      !section ||
      !validTime(section.start) ||
      !Array.isArray(section.points) ||
      section.points.length > 1000
    )
      throw new Error('总结章节结构无效。');
    values.push(section.title, ...section.points);
  }
  const seen = new Set<MindMapNode>();
  const visit = (node: MindMapNode, depth: number): void => {
    if (!node || seen.has(node) || depth > 12 || seen.size >= 2000)
      throw new Error('思维导图包含循环、超过 12 层或超过 2,000 个节点。');
    seen.add(node);
    values.push(node.title);
    if (node.start !== undefined && !validTime(node.start)) throw new Error('思维导图时间戳无效。');
    if (node.children !== undefined && !Array.isArray(node.children))
      throw new Error('思维导图子节点无效。');
    for (const child of node.children ?? []) visit(child, depth + 1);
  };
  if (summary.mindmap) visit(summary.mindmap, 0);
  if (values.some((value) => typeof value !== 'string' || value.length > 100_000))
    throw new Error('导出文本无效或单项超过 100,000 字符。');
  if (values.reduce<number>((size, value) => size + (value as string).length, 0) > 2_000_000)
    throw new Error('总结内容过大，请缩短后导出。');
}

function createdLabel(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
    : '未记录';
}

function documentNotes(doc: ExportDocument): string {
  const { summary, video } = doc;
  return [
    summary.overview,
    `视频：${video.title}`,
    `作者：${video.author}`,
    `来源：${sourceUrl(doc) ?? '无有效视频链接'}`,
    `生成时间：${createdLabel(doc.createdAt)}`,
    ...summary.sections.map(
      (section) => `\n${formatTime(section.start)} ${section.title}\n${section.points.join('\n')}`,
    ),
    `\n行动与启发\n${summary.takeaways.join('\n')}`,
    `\n总结提示词\n${doc.prompt}`,
  ].join('\n\n');
}

interface XMindTopic {
  id: string;
  class: 'topic';
  title: string;
  structureClass?: string;
  href?: string;
  notes?: { plain: { content: string } };
  children?: { attached: XMindTopic[] };
}

/** Sentence-per-node reads better in a map than one long paragraph. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？.!?])\s*|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * The mind map the model returns is only a skeleton of chapter titles, which is useless to
 * someone who never opens the video. This derives the map from the summary itself, so the
 * exported map carries the same substance as the printed notes: overview, every chapter with
 * its points and source time, and the takeaways.
 */
export function summaryMindMap(summary: Summary): MindMapNode {
  const children: MindMapNode[] = [];
  const overview = splitSentences(summary.overview).slice(0, 8);
  if (overview.length)
    children.push({ title: '内容概览', children: overview.map((title) => ({ title })) });
  for (const section of summary.sections) {
    const points = section.points.filter(Boolean);
    children.push({
      title: section.title,
      start: section.start,
      ...(points.length ? { children: points.map((title) => ({ title })) } : {}),
    });
  }
  const takeaways = summary.takeaways.filter(Boolean);
  if (takeaways.length)
    children.push({ title: '行动与启发', children: takeaways.map((title) => ({ title })) });
  return { title: summary.title, children };
}

/** XMind JSON archive layout follows the official xmindltd/xmind-sdk-js Zipper and Note schema.
 * https://github.com/xmindltd/xmind-sdk-js/blob/master/src/utils/zipper.ts
 * https://github.com/xmindltd/xmind-sdk-js/blob/master/src/core/note.ts
 */
export function buildXMind(
  doc: ExportDocument,
  options: { includeTimestamps?: boolean } = {},
): Uint8Array {
  validateDocument(doc);
  const includeTimestamps = options.includeTimestamps !== false;
  let nextId = 0;
  const topic = (node: MindMapNode): XMindTopic => {
    const timed = includeTimestamps && validTime(node.start);
    const result: XMindTopic = {
      id: `sidenote-topic-${nextId++}`,
      class: 'topic',
      title: timed ? `${node.title} [${formatTime(node.start!)}]` : node.title,
    };
    const href = sourceUrl(doc, timed ? node.start : undefined);
    if (href) result.href = href;
    if (timed)
      result.notes = { plain: { content: `视频位置：${formatTime(node.start!)}\n${href ?? ''}` } };
    if (node.children?.length) result.children = { attached: node.children.map(topic) };
    return result;
  };
  const root = topic(summaryMindMap(doc.summary));
  root.structureClass = 'org.xmind.ui.logic.right';
  root.notes = { plain: { content: documentNotes(doc) } };
  const content = [
    { id: 'sidenote-sheet-1', class: 'sheet', title: doc.summary.title, rootTopic: root },
  ];
  const files = {
    'content.json': strToU8(JSON.stringify(content)),
    'metadata.json': strToU8(
      JSON.stringify({
        creator: { name: 'Sidenote', version: '0.1.0' },
        activeSheetId: 'sidenote-sheet-1',
      }),
    ),
    'manifest.json': strToU8(
      JSON.stringify({ 'file-entries': { 'content.json': {}, 'metadata.json': {} } }),
    ),
  };
  return zipSync(files, { level: 6 });
}

export function buildMarkdown(doc: ExportDocument): string {
  validateDocument(doc);
  const { summary, video } = doc;
  const source = sourceUrl(doc);
  const time = (start: number): string => {
    const href = sourceUrl(doc, start);
    return href ? `[${formatTime(start)}](${href})` : formatTime(start);
  };
  const lines = [
    `# ${escapeMarkdown(summary.title)}`,
    '',
    `视频：${escapeMarkdown(video.title)}`,
    '',
    `作者：${escapeMarkdown(video.author)}`,
    '',
    `来源：${source ? `[YouTube](${source})` : '无有效视频链接'}`,
    '',
    `生成时间：${createdLabel(doc.createdAt)}`,
    '',
    '## 内容概览',
    '',
    escapeMarkdown(summary.overview),
    '',
    '## 章节总结',
    '',
  ];
  for (const section of summary.sections) {
    lines.push(
      `### ${time(section.start)} ${escapeMarkdown(section.title)}`,
      '',
      ...section.points.map((point) => `- ${escapeMarkdown(point)}`),
      '',
    );
  }
  lines.push(
    '## 行动与启发',
    '',
    ...summary.takeaways.map((item) => `- ${escapeMarkdown(item)}`),
    '',
    '## 章节大纲',
    '',
  );
  // The full tree lives in the XMind export; here the substance is already above, so this
  // stays a table of contents rather than repeating every point.
  lines.push(
    `- ${escapeMarkdown(summary.title)}`,
    ...summary.sections.map(
      (section) =>
        `  - ${escapeMarkdown(section.title)}${validTime(section.start) ? ` · ${time(section.start)}` : ''}`,
    ),
  );
  lines.push(
    '',
    '## 总结提示词',
    '',
    ...doc.prompt.split(/\r?\n/).map((line) => `    ${line}`),
    '',
  );
  return lines.join('\n');
}

/** No scripts or untrusted markup. The print page supplies the browser print action separately. */
export function buildPrintHtml(doc: ExportDocument): string {
  validateDocument(doc);
  const { summary, video } = doc;
  const source = sourceUrl(doc);
  const link = (label: string, href: string | undefined): string =>
    href
      ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${escapeHtml(label)}</a>`
      : escapeHtml(label);
  const time = (start: number): string =>
    `<span class="time">${link(formatTime(start), sourceUrl(doc, start))}</span>`;
  const list = (values: string[]): string =>
    `<ul>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join('')}</ul>`;
  const outline = (): string =>
    `<li><span>${escapeHtml(summary.title)}</span><ul>${summary.sections
      .map(
        (section) =>
          `<li>${validTime(section.start) ? time(section.start) : ''}<span>${escapeHtml(section.title)}</span></li>`,
      )
      .join('')}</ul></li>`;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${escapeHtml(summary.title)} · 旁听</title>
<style>
@page { size: A4; margin: 18mm 17mm; }
* { box-sizing: border-box; }
body { margin: 0; background: #edf0f2; color: #202326; font: 15px/1.75 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif; }
main { max-width: 210mm; margin: 24px auto; padding: 20mm 18mm; background: white; }
header { border-bottom: 2px solid #252d31; padding-bottom: 20px; margin-bottom: 28px; }
.brand { font-size: 12px; letter-spacing: .12em; color: #62696d; }
h1 { font-size: 29px; line-height: 1.35; margin: 14px 0; overflow-wrap: anywhere; }
h2 { font-size: 20px; margin: 30px 0 12px; break-after: avoid; }
h3 { font-size: 16px; margin: 22px 0 8px; break-after: avoid; }
p { white-space: pre-wrap; overflow-wrap: anywhere; }
dl { margin: 12px 0 0; font-size: 12px; color: #535c61; }
dt { display: inline; font-weight: 600; } dd { display: inline; margin: 0; overflow-wrap: anywhere; } dd::after { content: ""; display: block; }
a { color: #315d78; text-decoration: underline; overflow-wrap: anywhere; }
ul { padding-left: 22px; margin: 8px 0; } li { margin: 5px 0; overflow-wrap: anywhere; }
.time { font-size: 12px; font-weight: 500; margin-right: 8px; white-space: nowrap; }
.outline { border-left: 2px solid #c9d3d9; } .outline ul { border-left: 1px solid #e1e6e9; }
pre { padding: 14px; border: 1px solid #d8dfe3; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-size: 12px; }
footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #d8dfe3; font-size: 11px; color: #697277; }
@media print { body { background: white; font-size: 10.5pt; } main { max-width: none; margin: 0; padding: 0; } h1 { font-size: 22pt; } p, li { orphans: 3; widows: 3; } .appendix { break-before: page; } }
@media screen and (max-width: 640px) { main { margin: 0; padding: 24px; } }
</style></head><body><main>
<header><div class="brand">SIDENOTE / 旁听 · 视频学习笔记</div><h1>${escapeHtml(summary.title)}</h1>
<dl><dt>视频：</dt><dd>${escapeHtml(video.title)}</dd><dt>作者：</dt><dd>${escapeHtml(video.author)}</dd>
<dt>来源：</dt><dd>${link(source ?? '无有效视频链接', source)}</dd>
<dt>生成时间：</dt><dd>${escapeHtml(createdLabel(doc.createdAt))}</dd></dl></header>
<section><h2>内容概览</h2><p>${escapeHtml(summary.overview)}</p></section>
<section><h2>章节总结</h2>${summary.sections.map((section) => `<article><h3>${time(section.start)}${escapeHtml(section.title)}</h3>${list(section.points)}</article>`).join('')}</section>
<section><h2>行动与启发</h2>${list(summary.takeaways)}</section>
<section class="appendix"><h2>章节大纲</h2><ul class="outline">${outline()}</ul></section>
<section><h2>总结提示词</h2><pre>${escapeHtml(doc.prompt)}</pre></section>
<footer>由旁听生成 · 时间戳可点击返回视频对应位置。</footer>
</main></body></html>`;
}
