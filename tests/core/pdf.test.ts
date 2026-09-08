import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { buildPdf } from '../../src/core/pdf';
import type { ExportDocument } from '../../src/shared/types';

const font = new Uint8Array(readFileSync('extension/fonts/NotoSansSC-Subset.otf'));

function document(overrides: Partial<ExportDocument['summary']> = {}): ExportDocument {
  return {
    video: {
      id: 'QLLuZbuTIRc',
      title: 'How to Think Clearly In The Era Of AI: Full Course (5 Hours)',
      author: 'Nick Saraev',
      url: 'https://www.youtube.com/watch?v=QLLuZbuTIRc',
      duration: 18_139,
      currentTime: 0,
      paused: true,
      tracks: [],
    },
    summary: {
      title: '如何在 AI 时代清晰思考：完整课程（5 小时）',
      overview:
        '本视频是一门 5 小时课程的完整版，旨在帮助观众在 AI 和算法影响下重新掌握独立思考能力。课程涵盖认知的生物学基础、选择架构、贝叶斯定理、费米近似与规划谬误等概念。',
      sections: [
        {
          title: '课程介绍与作者背景',
          start: 0,
          points: ['视频时长 5 小时，目标是在一个鼓励不清晰思考的世界中学会清晰思考。'],
        },
        {
          title: '思维模型：切斯特顿围栏与尤利西斯契约',
          start: 9470.5,
          points: [
            '先理解规则存在的理由，再决定是否移除。',
            '提前对未来的自己设限，避免临场动摇。',
          ],
        },
      ],
      takeaways: ['把下一步写成可执行的行动清单。'],
      mindmap: undefined,
      ...overrides,
    },
    prompt: '请完整总结视频中的核心观点、章节、案例和可执行建议，保留相关时间戳。',
    createdAt: '2026-09-08T09:00:28.000Z',
  };
}

/** Production output uses object streams, so re-save without them to inspect the structure. */
async function reopen(bytes: Uint8Array): Promise<{ raw: string; pages: number }> {
  const loaded = await PDFDocument.load(bytes);
  const flat = await loaded.save({ useObjectStreams: false });
  return { raw: Buffer.from(flat).toString('latin1'), pages: loaded.getPageCount() };
}
async function structure(doc: ExportDocument): Promise<string> {
  return (await reopen(await buildPdf(doc, { font }))).raw;
}

describe('PDF export', () => {
  it('embeds the Chinese font as searchable CID text rather than an image', async () => {
    const bytes = await buildPdf(document(), { font });
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-');
    const { raw } = await reopen(bytes);
    // /ToUnicode is what makes the Chinese selectable, copyable and searchable in a reader.
    expect(raw).toContain('/ToUnicode');
    expect(raw).toContain('/Type0');
    expect(raw).toContain('/Identity-H');
    // Subsetting keeps a few pages of notes far below the 1.5 MB source font.
    expect(bytes.length).toBeLessThan(400_000);
  });

  it('links the source and every chapter timestamp back to the video', async () => {
    const raw = await structure(document());
    expect(raw).toContain('/Subtype /Link');
    expect(raw).toContain('https://www.youtube.com/watch?v=QLLuZbuTIRc');
    // 9470.5s -> 2:37:50, floored to whole seconds in the deep link.
    expect(raw).toContain('t=9470s');
  });

  it('flows long documents onto more pages instead of overprinting one', async () => {
    const short = await reopen(await buildPdf(document(), { font }));
    const long = await reopen(
      await buildPdf(
        document({
          sections: Array.from({ length: 40 }, (_, index) => ({
            title: `第 ${index + 1} 章 · 认知偏差与决策质量`,
            start: index * 120,
            points: [
              '这一段用足够长的中文说明，确保换行与分页逻辑都会被真正触发，而不是停留在第一页。',
              '第二条要点同样需要占据整行，以便验证项目符号与缩进在跨页时依然对齐。',
            ],
          })),
        }),
        { font },
      ),
    );
    expect(short.pages).toBe(1);
    expect(long.pages).toBeGreaterThan(3);
  });

  it('drops glyphs the subset lacks instead of failing the export', async () => {
    // Emoji and rare CJK are plausible in model output and are not in the bundled subset.
    await expect(
      buildPdf(document({ title: '总结 🎬 完成 𠀋', takeaways: ['行动 ✅ 清单'] }), { font }),
    ).resolves.toBeInstanceOf(Uint8Array);
  });

  it('rejects a malformed document before rendering anything', async () => {
    const broken = document();
    broken.summary.sections[0]!.start = Number.NaN;
    await expect(buildPdf(broken, { font })).rejects.toThrow('章节结构');
  });
});
