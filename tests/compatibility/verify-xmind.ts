/** Opt-in independent compatibility check. Downloads pinned public test tools; never uploads the file. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildXMind } from '../../src/core/exports';
import type { ExportDocument, MindMapNode } from '../../src/shared/types';

const packages = [
  {
    name: 'xmind-viewer',
    version: '1.1.2',
    integrity:
      'qn/b9RjxmhmzvLGpgcaLUTJRjZFwmkxg8nvR5IfLDNfwwomfhgO7iUf12+dU2ENbdaNcRAZf6R0P8PaGJN6B7Q==',
  },
  {
    name: 'jszip',
    version: '3.10.1',
    integrity:
      'xXDvecyTpGLrqFrvkrUSoxxfJI5AH7U8zxxtVclpsUtMCq4JQ290LY8AW5c7Ggnr/Y/oK+bQMbqK2qmtk3pN4g==',
  },
];

interface Archive {
  file(path: string): { async(type: 'text'): Promise<string> } | null;
}
interface ImportedTopic {
  title: string;
  href?: string;
  notes?: { plain: { content: string } };
  children?: { attached: ImportedTopic[] };
}
interface ImportedSheet {
  rootTopic: ImportedTopic;
}
interface ViewerTopic {
  title: string;
  structureClass: string;
  getChildrenByType(type: 'attached'): ViewerTopic[];
}

const require = createRequire(import.meta.url);
const temporary = await mkdtemp(join(tmpdir(), 'sidenote-xmind-compat-'));
const artifacts = fileURLToPath(new URL('./artifacts/', import.meta.url));

try {
  await Promise.all(
    packages.map(async ({ name, version, integrity }) => {
      const url = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      assert.equal(response.ok, true, `Cannot download ${name}: ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.equal(
        createHash('sha512').update(bytes).digest('base64'),
        integrity,
        `${name} package integrity differs`,
      );
      const directory = join(temporary, name);
      const archive = join(temporary, `${name}.tgz`);
      await mkdir(directory);
      await writeFile(archive, bytes);
      // These exact, integrity-checked registry archives contain only public package code.
      execFileSync('tar', ['-xzf', archive, '-C', directory], { windowsHide: true });
    }),
  );

  const JSZip = require(join(temporary, 'jszip/package/dist/jszip.min.js')) as {
    loadAsync(bytes: Uint8Array, options?: { checkCRC32: boolean }): Promise<Archive>;
  };
  const { loadFromXMind } = require(
    join(temporary, 'xmind-viewer/package/dist/xmindLoader.js'),
  ) as {
    loadFromXMind(zip: Archive): Promise<{ sheets: ImportedSheet[] }>;
  };
  const { Workbook } = require(join(temporary, 'xmind-viewer/package/dist/model/workbook.js')) as {
    Workbook: new (sheets: ImportedSheet[]) => {
      getSheetByIndex(index: number): { rootTopic: ViewerTopic };
    };
  };

  const children: MindMapNode[] = Array.from({ length: 25 }, (_, index) => ({
    title: `第 ${index + 1} 章 · 中文 / 日本語 / العربية / עברית / 한글 / 😀`,
    start: index * 720,
    children: [
      { title: `观点 ${index + 1}：“引号” & <文字>`, start: index * 720 + 15 },
      { title: `行动 ${index + 1}：练习并复盘`, start: index * 720 + 90 },
    ],
  }));
  const doc: ExportDocument = {
    video: {
      id: 'dQw4w9WgXcQ',
      title: '兼容性测试视频（人工测试数据）',
      author: 'Sidenote test fixture',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      duration: 18020,
      currentTime: 0,
      paused: true,
      tracks: [],
    },
    summary: {
      title: '兼容性测试 · 多语种学习笔记',
      overview: '验证实际 ZIP 读取、官方导图模型和多语种文本。',
      sections: children.map((node) => ({
        title: node.title,
        start: node.start!,
        points: node.children!.map((child) => child.title),
      })),
      takeaways: ['官方读取器应保留全部节点。'],
      mindmap: { title: '学习总结', children },
    },
    prompt: '人工兼容性测试夹具，并非真实视频总结。',
    createdAt: '2026-09-07T08:00:00.000Z',
  };
  const bytes = buildXMind(doc);
  await mkdir(artifacts, { recursive: true });
  const filename = join(artifacts, 'multilingual-learning-notes.xmind');
  await writeFile(filename, bytes);
  const diskBytes = await readFile(filename);
  const zip = await JSZip.loadAsync(diskBytes, { checkCRC32: true });
  const loaded = await loadFromXMind(zip);
  assert.equal(loaded.sheets.length, 1);
  const workbook = new Workbook(loaded.sheets);
  const root = workbook.getSheetByIndex(0).rootTopic;
  assert.equal(root.title, '学习总结');
  assert.equal(root.structureClass, 'org.xmind.ui.logic.right');
  assert.equal(root.getChildrenByType('attached').length, 25);
  const titles: string[] = [];
  const walk = (node: ViewerTopic): void => {
    titles.push(node.title);
    node.getChildrenByType('attached').forEach(walk);
  };
  walk(root);
  assert.equal(titles.length, 76);
  assert.ok(titles.includes('第 25 章 · 中文 / 日本語 / العربية / עברית / 한글 / 😀 [4:48:00]'));
  assert.ok(titles.includes('观点 25：“引号” & <文字> [4:48:15]'));
  const importedRoot = loaded.sheets[0]!.rootTopic;
  assert.equal(
    importedRoot.children!.attached[24]!.href,
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=17280s',
  );
  assert.ok(importedRoot.notes!.plain.content.includes(doc.prompt));
  assert.ok(importedRoot.notes!.plain.content.includes('行动 25：练习并复盘'));
  const manifest = JSON.parse(await zip.file('manifest.json')!.async('text')) as {
    'file-entries': Record<string, unknown>;
  };
  for (const name of Object.keys(manifest['file-entries'])) assert.ok(zip.file(name));
  await assert.rejects(() => JSZip.loadAsync(diskBytes.subarray(0, 40), { checkCRC32: true }));

  const evidence = {
    checkedAt: new Date().toISOString(),
    packages: packages.map(({ name, version }) => `${name}@${version}`),
    independentReads: [
      'JSZip.loadAsync(checkCRC32=true)',
      'xmind-viewer.loadFromXMind',
      'new xmind-viewer.Workbook',
    ],
    generatedFile: 'tests/compatibility/artifacts/multilingual-learning-notes.xmind',
    bytes: diskBytes.byteLength,
    sha256: createHash('sha256').update(diskBytes).digest('hex'),
    sheets: loaded.sheets.length,
    rootChildren: root.getChildrenByType('attached').length,
    totalTopics: titles.length,
    verified: [
      'UTF-8 multilingual text and emoji',
      'all 76 model topics',
      'nested hierarchy',
      '4+ hour timestamps',
      'chapter YouTube hyperlinks',
      'notes including prompt',
      'manifest references',
      'truncated ZIP rejected',
    ],
    limitation:
      'Parser/model compatibility only; no XMind desktop rendering or edit/save round-trip claim.',
  };
  await writeFile(
    join(artifacts, 'xmind-validation.json'),
    JSON.stringify(evidence, null, 2) + '\n',
  );
  process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
} finally {
  // Delete only the exact task-specific temporary directory returned by mkdtemp.
  await rm(temporary, { recursive: true, force: true });
}
