import { describe, expect, it } from 'vitest';
import {
  answerSchema,
  digestSchema,
  outlineSchema,
  summarySchema,
} from '../../src/background/validation';
import type { MindMapNode } from '../../src/shared/types';

function deepNode(levels: number): MindMapNode {
  return levels <= 0
    ? { title: `leaf` }
    : { title: `level-${levels}`, children: [deepNode(levels - 1)] };
}
function depthOf(node: MindMapNode): number {
  return 1 + Math.max(0, ...(node.children ?? []).map(depthOf));
}
function wideNode(children: number): MindMapNode {
  return {
    title: 'root',
    children: Array.from({ length: children }, (_, index) => ({
      title: `branch-${index}`,
      children: Array.from({ length: 20 }, (_, leaf) => ({ title: `leaf-${index}-${leaf}` })),
    })),
  };
}
function countNodes(node: MindMapNode): number {
  return 1 + (node.children ?? []).reduce((total, child) => total + countNodes(child), 0);
}

const validSummary = {
  title: 'Title',
  overview: 'Overview',
  sections: [{ title: 'Chapter', start: 0, points: ['Point'] }],
  takeaways: ['Takeaway'],
  mindmap: { title: 'Root', children: [{ title: 'Chapter', start: 0 }] },
};

describe('lenient model output schemas', () => {
  it('clamps over-long text instead of discarding the whole response', () => {
    const digest = digestSchema.parse({
      overview: 'x'.repeat(5000),
      notes: [{ start: 1, text: 'y'.repeat(2000) }],
    });
    expect(digest.overview).toHaveLength(1200);
    expect(digest.notes[0]!.text).toHaveLength(500);
  });

  it('cuts over-long lists rather than rejecting them', () => {
    const digest = digestSchema.parse({
      overview: 'Fine',
      notes: Array.from({ length: 40 }, (_, index) => ({ start: index, text: `note ${index}` })),
    });
    expect(digest.notes).toHaveLength(12);
  });

  it('accepts the clock timestamps models return instead of seconds', () => {
    expect(
      digestSchema.parse({ overview: '', notes: [{ start: '4:19', text: 'a' }] }).notes[0]!.start,
    ).toBe(259);
    expect(
      outlineSchema.parse({ sections: [{ title: 'A', start: '01:04:19' }] }).sections[0]!.start,
    ).toBe(3859);
    expect(
      outlineSchema.parse({ sections: [{ title: 'A', start: '90' }] }).sections[0]!.start,
    ).toBe(90);
  });

  it('keeps a usable timestamp of 0 when the model returns nonsense', () => {
    // Snapping to real evidence happens afterwards; failing the batch here is far worse.
    expect(
      outlineSchema.parse({ sections: [{ title: 'A', start: 'sometime later' }] }).sections[0]!
        .start,
    ).toBe(0);
  });

  it('drops unusable list items instead of failing their container', () => {
    const outline = outlineSchema.parse({
      sections: [{ title: 'Kept', start: 0 }, { title: '', start: 5 }, 'nonsense', null],
    });
    expect(outline.sections).toEqual([{ title: 'Kept', start: 0 }]);
  });

  it('keeps a chapter that came back without points', () => {
    const summary = summarySchema.parse({
      ...validSummary,
      sections: [{ title: 'Chapter', start: 0, points: [] }],
    });
    expect(summary.sections[0]).toEqual({ title: 'Chapter', start: 0, points: [] });
  });

  it('falls back to an empty title and overview rather than failing', () => {
    const summary = summarySchema.parse({ ...validSummary, title: undefined, overview: 42 });
    expect(summary.title).toBe('');
    expect(summary.overview).toBe('42');
  });

  it('trims an over-deep or over-large mindmap to its top levels', () => {
    const deep = summarySchema.parse({ ...validSummary, mindmap: deepNode(12) });
    expect(depthOf(deep.mindmap!)).toBeLessThanOrEqual(7);
    const wide = summarySchema.parse({ ...validSummary, mindmap: wideNode(40) });
    expect(countNodes(wide.mindmap!)).toBeLessThanOrEqual(200);
  });

  it('still fails a response with nothing usable so the client can retry', () => {
    expect(summarySchema.safeParse({ ...validSummary, sections: [] }).success).toBe(false);
    expect(outlineSchema.safeParse({ sections: [] }).success).toBe(false);
    expect(answerSchema.safeParse({ text: '', citations: [] }).success).toBe(false);
  });

  it('preserves a well-formed response unchanged', () => {
    expect(summarySchema.parse(validSummary)).toEqual(validSummary);
    expect(
      answerSchema.parse({ text: 'Answer', citations: [{ start: 3, label: 'Cite' }] }),
    ).toEqual({ text: 'Answer', citations: [{ start: 3, label: 'Cite' }] });
  });
});
