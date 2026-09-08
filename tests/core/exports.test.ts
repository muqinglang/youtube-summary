import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { buildMarkdown, buildPrintHtml, buildXMind } from '../../src/core/exports';
import type { ExportDocument, MindMapNode } from '../../src/shared/types';

function document(): ExportDocument {
  return {
    video: {
      id: 'dQw4w9WgXcQ',
      title: '深度学习与思考',
      author: 'Example',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      duration: 18_020,
      currentTime: 0,
      paused: true,
      tracks: [],
    },
    summary: {
      title: '学会思考',
      overview: '第一行\n第二行。',
      sections: [{ title: '核心观点', start: 90.5, points: ['观点 A', '观点 B'] }],
      takeaways: ['每天练习'],
      mindmap: {
        title: '中心主题',
        children: [
          { title: '分支', start: 90, children: [{ title: '细节', start: 3723 }] },
          { title: '其他' },
        ],
      },
    },
    prompt: '保留重点，附时间戳。',
    createdAt: '2026-09-07T08:00:00.000Z',
  };
}

describe('XMind archive', () => {
  it('produces UTF-8 JSON workbook with official archive entries, hierarchy, notes and links', () => {
    const archive = buildXMind(document());
    expect([...archive.slice(0, 2)]).toEqual([0x50, 0x4b]);
    const zip = unzipSync(archive);
    expect(Object.keys(zip).sort()).toEqual(['content.json', 'manifest.json', 'metadata.json']);
    const manifest = JSON.parse(strFromU8(zip['manifest.json']!));
    expect(Object.keys(manifest['file-entries']).sort()).toEqual(['content.json', 'metadata.json']);
    const sheets = JSON.parse(strFromU8(zip['content.json']!));
    expect(sheets).toHaveLength(1);
    expect(sheets[0]).toMatchObject({ class: 'sheet', title: '学会思考' });
    expect(sheets[0].rootTopic).toMatchObject({
      class: 'topic',
      title: '学会思考',
      structureClass: 'org.xmind.ui.logic.right',
    });
    expect(sheets[0].rootTopic.notes.plain.content).toContain('观点 B');
    expect(sheets[0].rootTopic.notes.plain.content).toContain('保留重点，附时间戳。');
    // The map is derived from the summary, so it must carry overview, points and takeaways —
    // enough to follow the video without watching it.
    const [overview, chapter, takeaways] = sheets[0].rootTopic.children.attached;
    expect(overview.title).toBe('内容概览');
    expect(overview.children.attached.map((t: { title: string }) => t.title)).toEqual([
      '第一行',
      '第二行。',
    ]);
    expect(chapter.title).toBe('核心观点 [1:30]');
    expect(chapter.href).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s');
    expect(chapter.children.attached.map((t: { title: string }) => t.title)).toEqual([
      '观点 A',
      '观点 B',
    ]);
    expect(takeaways.title).toBe('行动与启发');
    expect(takeaways.children.attached[0].title).toBe('每天练习');
    const ids: string[] = [];
    interface ArchiveTopic {
      id: string;
      children?: { attached: ArchiveTopic[] };
    }
    const collect = (topic: ArchiveTopic): void => {
      ids.push(topic.id);
      topic.children?.attached.forEach(collect);
    };
    collect(sheets[0].rootTopic);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(9);
    const metadata = JSON.parse(strFromU8(zip['metadata.json']!));
    expect(metadata.activeSheetId).toBe(sheets[0].id);
    expect(metadata.creator.name).toBe('Sidenote');
  });

  it('can omit timestamp labels without changing the original document', () => {
    const doc = document();
    const before = structuredClone(doc);
    const files = unzipSync(buildXMind(doc, { includeTimestamps: false }));
    const root = JSON.parse(strFromU8(files['content.json']!))[0].rootTopic;
    expect(root.children.attached[1].title).toBe('核心观点');
    expect(doc).toEqual(before);
  });
});

describe('document exports', () => {
  it('prints standalone A4 HTML with Chinese fonts and clickable chapter source times', () => {
    const html = buildPrintHtml(document());
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('size: A4');
    expect(html).toContain('Microsoft YaHei');
    expect(html).toContain('t=90s');
    expect(html).toContain('1:30');
    expect(html).toContain('观点 B');
    expect(html).toContain('生成时间：');
    expect(html).toContain('2026-09-07 08:00:00 UTC');
    expect(html).toContain('break-before: page');
  });

  it('escapes AI/user fields as text in every HTML position', () => {
    const doc = document();
    const payload = '</title><script>alert("owned")</script><img src=x onerror=alert(1)>';
    doc.summary.title = payload;
    doc.summary.overview = payload;
    doc.summary.sections[0]!.points.push(payload);
    doc.summary.sections[0]!.title = payload;
    doc.prompt = '</pre>' + payload;
    doc.video.author = payload;
    const html = buildPrintHtml(doc);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain(payload);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;/pre&gt;');
    expect(html).toContain('&quot;owned&quot;');
  });

  it('never turns a supplied javascript/data URL into a source link', () => {
    const doc = document();
    doc.video.id = 'bad';
    doc.video.url = 'javascript:alert(1)';
    const html = buildPrintHtml(doc);
    expect(html).not.toContain('href=');
    expect(html).toContain('无有效视频链接');
    const files = unzipSync(buildXMind(doc));
    expect(strFromU8(files['content.json']!)).not.toContain('javascript:');
  });

  it('canonicalizes valid short YouTube URLs and ignores untrusted URL query parameters', () => {
    const doc = document();
    doc.video.id = '';
    doc.video.url = 'https://youtu.be/dQw4w9WgXcQ?utm_source=x&fake=javascript:bad';
    expect(buildMarkdown(doc)).toContain('[YouTube](https://www.youtube.com/watch?v=dQw4w9WgXcQ)');
    expect(buildMarkdown(doc)).not.toContain('fake=');
  });

  it('writes human-readable Markdown with tree and escaped user-supplied Markdown/HTML', () => {
    const doc = document();
    doc.summary.overview = '<script>bad</script> [link](javascript:bad)';
    doc.prompt = '```\n<script> literal prompt\n```';
    const md = buildMarkdown(doc);
    expect(md).toContain('# 学会思考');
    expect(md).toContain('## 章节大纲');
    expect(md).toContain('- 学会思考');
    expect(md).toContain('  - 核心观点 · [1:30]');
    expect(md).toContain('&lt;script&gt;bad&lt;/script&gt;');
    expect(md).toContain('\\[link\\]\\(javascript:bad\\)');
    expect(md).toContain('    ```\n    <script> literal prompt\n    ```');
  });

  it('rejects pathological recursive trees and invalid timestamps in every export', () => {
    for (const build of [buildPrintHtml, buildMarkdown, buildXMind]) {
      const doc = document();
      doc.summary.mindmap!.children!.push(doc.summary.mindmap!);
      expect(() => build(doc)).toThrow('循环');
      const invalid = document();
      invalid.summary.sections[0]!.start = NaN;
      expect(() => build(invalid)).toThrow('章节结构');
    }
  });

  it('rejects unreasonable tree depth before rendering', () => {
    const doc = document();
    let node: MindMapNode = doc.summary.mindmap!;
    for (let index = 0; index < 14; index++) {
      const next = { title: 'nested' };
      node.children = [next];
      node = next;
    }
    expect(() => buildPrintHtml(doc)).toThrow('12 层');
  });
});
