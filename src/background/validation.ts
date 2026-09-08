import { z } from 'zod';
import type { AiRequest, MindMapNode, Outline, Summary } from '../shared/types';

const seconds = z.number().finite().min(0).max(604800);
export const videoSchema = z.object({
  id: z.string().min(1).max(200),
  title: z.string().max(1000),
  author: z.string().max(500),
  url: z.string().max(4000),
  duration: seconds,
  currentTime: seconds,
  paused: z.boolean(),
  chapters: z
    .array(z.object({ title: z.string().min(1).max(500), start: seconds }))
    .max(500)
    .optional(),
  tracks: z
    .array(
      z.object({
        id: z.string().max(1000),
        language: z.string().max(100),
        name: z.string().max(500),
        automatic: z.boolean(),
      }),
    )
    .max(1000),
});
const cueSchema = z
  .object({
    id: z.string().min(1).max(200),
    start: seconds,
    end: seconds,
    text: z.string().min(1).max(10000),
  })
  .refine((cue) => cue.end >= cue.start);
const transcriptSchema = z
  .object({
    videoId: z.string().min(1).max(200),
    language: z.string().max(100),
    source: z.enum(['youtube', 'import']),
    coverage: z.enum(['complete', 'unknown']),
    cues: z.array(cueSchema).min(1).max(100000),
  })
  .refine(({ cues }) => new Set(cues.map((cue) => cue.id)).size === cues.length)
  .refine(({ cues }) => cues.reduce((size, cue) => size + cue.text.length, 0) <= 2_000_000);
const language = z.string().trim().min(1).max(100);

/** Requests come from our own UI, so they stay strictly validated. */
export const aiRequestSchema: z.ZodType<AiRequest> = z.discriminatedUnion('task', [
  z.object({
    task: z.literal('summarize'),
    video: videoSchema,
    transcript: transcriptSchema,
    prompt: z.string().max(8000),
    language,
  }),
  z.object({
    task: z.literal('outline'),
    video: videoSchema,
    transcript: transcriptSchema,
    language,
  }),
  z.object({ task: z.literal('translate'), transcript: transcriptSchema, language }),
  z.object({
    task: z.literal('ask'),
    video: videoSchema,
    transcript: transcriptSchema,
    question: z.string().trim().min(1).max(4000),
    language,
  }),
]);

// ---------------------------------------------------------------------------
// Model output schemas.
//
// These are deliberately lenient. A long video is analysed in dozens of
// sequential calls, so rejecting a whole response because the model wrote 1250
// characters where the prompt asked for 1200 throws away every earlier call as
// well. Limits below therefore CLAMP instead of reject: over-long text is
// truncated, over-long lists are cut, unusable list items are dropped, and only
// a genuinely unusable object fails. Structural requirements the caller cannot
// work around (an outline with no sections at all) still fail so the retry and
// repair path in the client can kick in.
// ---------------------------------------------------------------------------

/** Accept the near-misses models produce for a string field, then trim and clamp. */
function outputText(max: number, required = true) {
  const text = z
    .preprocess((value) => {
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      if (Array.isArray(value)) return value.filter((item) => typeof item === 'string').join(' ');
      return value;
    }, z.string())
    .transform((value) => value.trim().slice(0, max));
  return required ? text.refine((value) => value.length > 0, '文本为空') : text.catch('');
}

/** Models routinely return "4:19" or "01:04:19" where the schema asks for seconds. */
function parseClock(raw: string): number | undefined {
  const text = raw.trim();
  if (/^\d+(?:[.,]\d+)?$/.test(text)) return Number(text.replace(',', '.'));
  const match = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2}(?:[.,]\d+)?)$/.exec(text);
  if (!match) return undefined;
  return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]!.replace(',', '.'));
}
function coerceSeconds(value: unknown): unknown {
  if (typeof value === 'string') return parseClock(value);
  return value;
}
/** A wrong timestamp is snapped to real evidence later; failing the batch is far worse. */
const outputSeconds = z.preprocess(coerceSeconds, seconds).catch(0);
const optionalSeconds = z.preprocess(coerceSeconds, seconds.optional()).catch(undefined);

/** Keep the usable items of a list instead of failing the object that contains it. */
function outputArray<T>(item: z.ZodType<T>, max: number): z.ZodType<T[]> {
  return z
    .preprocess(
      (value) =>
        Array.isArray(value) ? value : value === undefined || value === null ? [] : [value],
      z.array(z.unknown()),
    )
    .transform((items) => {
      const kept: T[] = [];
      for (const raw of items) {
        if (kept.length >= max) break;
        const parsed = item.safeParse(raw);
        if (parsed.success) kept.push(parsed.data);
      }
      return kept;
    })
    .catch([] as T[]);
}

const MAX_MIND_MAP_NODES = 200;
function mindMapSchema(depth: number): z.ZodType<MindMapNode> {
  // Beyond the depth limit the extra levels are dropped, not treated as an error.
  const children: z.ZodType<MindMapNode[]> =
    depth > 0
      ? outputArray(mindMapSchema(depth - 1), 30)
      : z.unknown().transform((): MindMapNode[] => []);
  return z
    .object({ title: outputText(500), start: optionalSeconds, children: children.optional() })
    .transform((node): MindMapNode => ({
      title: node.title,
      ...(node.start === undefined ? {} : { start: node.start }),
      ...(node.children?.length ? { children: node.children } : {}),
    }));
}

/** Breadth-first budget so an over-large map keeps its top levels rather than failing. */
function pruneMindMap(root: MindMapNode): MindMapNode {
  let budget = MAX_MIND_MAP_NODES - 1;
  const walk = (node: MindMapNode): MindMapNode => {
    const kept: MindMapNode[] = [];
    for (const child of node.children ?? []) {
      if (budget <= 0) break;
      budget -= 1;
      kept.push(child);
    }
    return { ...node, ...(kept.length ? { children: kept.map(walk) } : { children: undefined }) };
  };
  return walk(root);
}

export const summarySchema: z.ZodType<Summary> = z.object({
  title: outputText(500, false),
  overview: outputText(12000, false),
  sections: outputArray(
    z.object({
      title: outputText(500),
      start: outputSeconds,
      points: outputArray(outputText(2000), 20),
    }),
    60,
  ).refine((sections) => sections.length > 0, '总结缺少章节'),
  takeaways: outputArray(outputText(2000), 30),
  mindmap: mindMapSchema(6).transform(pruneMindMap).optional(),
});

export const outlineSchema: z.ZodType<Outline> = z.object({
  sections: outputArray(z.object({ title: outputText(500), start: outputSeconds }), 80).refine(
    (sections) => sections.length > 0,
    '内容目录为空',
  ),
});

export const answerSchema = z.object({
  text: outputText(20000),
  citations: outputArray(z.object({ start: outputSeconds, label: outputText(500) }), 30),
});

export interface Digest {
  overview: string;
  notes: { start: number; text: string }[];
}
export const digestSchema: z.ZodType<Digest> = z.object({
  overview: outputText(1200, false),
  notes: outputArray(z.object({ start: outputSeconds, text: outputText(500) }), 12),
});
