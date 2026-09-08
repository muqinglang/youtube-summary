import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { Cue } from '../shared/types';

const MAX_INPUT_LENGTH = 10 * 1024 * 1024;
const MAX_CUES = 100_000;
const MAX_CUE_LENGTH = 100_000;
const MAX_SECONDS = 7 * 24 * 60 * 60;
type Format = 'srt' | 'vtt' | 'json3' | 'xml';
type ObjectValue = Record<string, unknown>;

function object(value: unknown): ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
}

function number(value: unknown, label: string): number {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'string' && !value.trim())
  ) {
    throw new Error(`字幕${label}缺失或无效。`);
  }
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) throw new Error(`字幕${label}必须是非负有限数值。`);
  return result;
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    lrm: '\u200e',
    rlm: '\u200f',
  };
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (!name.startsWith('#')) return named[name.toLowerCase()] ?? entity;
    const point =
      name[1]?.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point)
      : '\ufffd';
  });
}

function cleanText(text: string): string {
  if (text.length > MAX_CUE_LENGTH) throw new Error('单条字幕超过 100,000 字符，请拆分后导入。');
  return decodeEntities(
    text
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<\/?(?:b|i|u|c|v|lang|ruby|rt|font|span)(?:[.\s][^>]*)?>/gi, '')
      .replace(/<\d{2,}:\d{2}(?::\d{2})?[.,]\d{3}>/g, ''),
  )
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t \u00a0]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

/** Validates and sorts cues. Only overlapping exact duplicates / repeated full rolling lines are removed. */
export function normalizeCues(cues: Cue[]): Cue[] {
  if (!Array.isArray(cues) || cues.length > MAX_CUES)
    throw new Error('字幕条数无效或超过 100,000 条。');
  const sorted = cues
    .map((cue, index) => {
      if (!cue || typeof cue.text !== 'string') throw new Error(`第 ${index + 1} 条字幕缺少文本。`);
      const start = number(cue.start, '开始时间');
      const end = number(cue.end, '结束时间');
      if (end <= start || end > MAX_SECONDS)
        throw new Error(`第 ${index + 1} 条字幕时间范围无效（最多 7 天）。`);
      return {
        id: typeof cue.id === 'string' && cue.id ? cue.id : `cue-${index}`,
        start,
        end,
        text: cleanText(cue.text),
      };
    })
    .filter((cue) => cue.text)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const result: Cue[] = [];
  const ids = new Set<string>();
  const suffixes = new Map<string, number>();
  for (const original of sorted) {
    const cue = { ...original };
    const previous = result.at(-1);
    if (previous && cue.start < previous.end) {
      if (previous.text === cue.text) {
        previous.end = Math.max(previous.end, cue.end);
        continue;
      }
      // YouTube rolling captions repeat the previous line above the new one.
      const before = previous.text.split('\n');
      const after = cue.text.split('\n');
      if (after.length > 1) {
        for (let count = Math.min(before.length, after.length - 1); count > 0; count--) {
          if (before.slice(-count).join('\n') === after.slice(0, count).join('\n')) {
            cue.text = after.slice(count).join('\n');
            break;
          }
        }
      }
    }
    const baseId = cue.id;
    let suffix = suffixes.get(baseId) ?? 1;
    while (ids.has(cue.id)) cue.id = `${baseId}-${suffix++}`;
    suffixes.set(baseId, suffix);
    ids.add(cue.id);
    result.push(cue);
  }
  return result;
}

function timestamp(value: string): number {
  const match = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)[.,](\d{3})$/.exec(value);
  if (!match) throw new Error(`字幕时间戳格式无效：${value}`);
  return (
    Number(match[1] ?? 0) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3]) +
    Number(match[4]) / 1000
  );
}

function parseTimedText(text: string, format: 'srt' | 'vtt'): Cue[] {
  const blocks = text
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n[ \t]*\n/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    if (
      format === 'vtt' &&
      /^(WEBVTT(?:[ \t]|$)|NOTE(?:[ \t]|$)|STYLE$|REGION$)/.test(lines[0] ?? '')
    )
      continue;
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0 || timingIndex > 1)
      throw new Error('字幕段缺少有效时间戳，请使用 SRT 或 WebVTT 文件。');
    const timing = /^\s*(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(lines[timingIndex] ?? '');
    if (!timing) throw new Error('字幕时间戳分隔格式无效。');
    const start = timestamp(timing[1]!);
    const end = timestamp(timing[2]!);
    const content = lines.slice(timingIndex + 1).join('\n');
    if (!content.trim()) continue;
    cues.push({ id: `cue-${cues.length}`, start, end, text: content });
  }
  return cues;
}

function parseJson3(text: string): Cue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('YouTube JSON 字幕格式无效。');
  }
  const events = object(parsed).events;
  if (!Array.isArray(events) || events.length > MAX_CUES)
    throw new Error('YouTube 字幕缺少有效 events 列表。');
  const cues: Cue[] = [];
  events.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('YouTube 字幕事件格式无效。');
    const event = object(raw);
    if (event.segs !== undefined && !Array.isArray(event.segs))
      throw new Error('YouTube 字幕片段列表无效。');
    if (!Array.isArray(event.segs) || !event.segs.length) return; // Window/style events are not spoken captions.
    const segments = event.segs.map((segment: unknown) => object(segment));
    if (segments.some((segment) => typeof segment.utf8 !== 'string'))
      throw new Error('YouTube 字幕片段缺少文本。');
    const content = segments.map((segment) => segment.utf8 as string).join('');
    if (!content.trim()) return;
    const eventStart = number(event.tStartMs, '开始时间') / 1000;
    const offsets = segments.map((segment) => number(segment.tOffsetMs ?? 0, '片段偏移') / 1000);
    const firstText = segments.findIndex((segment) => (segment.utf8 as string).trim());
    const start = eventStart + (offsets[firstText] ?? 0);
    const duration = number(event.dDurationMs ?? 0, '持续时间') / 1000;
    let end = eventStart + duration;
    if (duration === 0) {
      let next: unknown;
      for (let nextIndex = index + 1; nextIndex < events.length; nextIndex++) {
        if (Number(object(events[nextIndex]).tStartMs) > start * 1000) {
          next = events[nextIndex];
          break;
        }
      }
      // Some JSON3 streams omit duration; use the next event or a bounded final reading interval.
      end = next
        ? number(object(next).tStartMs, '开始时间') / 1000
        : eventStart + offsets.reduce((max, offset) => Math.max(max, offset), 0) + 3;
    }
    if (offsets.some((offset) => eventStart + offset > end))
      throw new Error('字幕片段偏移超出持续时间。');
    cues.push({ id: `cue-${index}`, start, end, text: content });
  });
  return cues;
}

function xmlText(nodes: unknown, depth = 0): string {
  if (depth > 20) throw new Error('字幕 XML 嵌套过深。');
  if (!Array.isArray(nodes)) return '';
  return nodes
    .map((raw: unknown) => {
      const node = object(raw);
      return Object.entries(node)
        .map(([tag, value]) => {
          if (tag === '#text') return String(value);
          if (tag === 'br') return '\n';
          return tag === ':@' ? '' : xmlText(value, depth + 1);
        })
        .join('');
    })
    .join('');
}

function parseXml(text: string): Cue[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('字幕 XML 不支持 DTD 或自定义实体。');
  if (XMLValidator.validate(text) !== true) throw new Error('XML 字幕格式无效。');
  const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: false,
    processEntities: false,
  });
  const parsed: unknown = parser.parse(text);
  if (!Array.isArray(parsed)) throw new Error('XML 字幕格式无效。');
  const root = parsed
    .map((node: unknown) => object(node))
    .find((node) => node.transcript || node.timedtext);
  if (!root) throw new Error('仅支持 YouTube transcript / timedtext XML 字幕。');
  const cues: Cue[] = [];
  const walk = (nodes: unknown, depth: number): void => {
    if (depth > 20) throw new Error('字幕 XML 嵌套过深。');
    if (!Array.isArray(nodes)) return;
    for (const raw of nodes) {
      const node = object(raw);
      const attrs = object(node[':@']);
      if (node.text !== undefined || node.p !== undefined) {
        const classic = node.text !== undefined;
        const body = classic ? node.text : node.p;
        const content = xmlText(body);
        if (!content.trim()) continue;
        const base = number(attrs[classic ? '@_start' : '@_t'], '开始时间') / (classic ? 1 : 1000);
        const duration =
          number(attrs[classic ? '@_dur' : '@_d'], '持续时间') / (classic ? 1 : 1000);
        const firstSegment = Array.isArray(body)
          ? body.map((value: unknown) => object(value)).find((value) => value.s)
          : undefined;
        const offset =
          classic || !firstSegment
            ? 0
            : number(object(firstSegment[':@'])['@_t'] ?? 0, '片段偏移') / 1000;
        cues.push({
          id: `cue-${cues.length}`,
          start: base + offset,
          end: base + duration,
          text: content,
        });
      } else {
        for (const [tag, children] of Object.entries(node))
          if (tag !== ':@') walk(children, depth + 1);
      }
    }
  };
  walk(root.transcript ?? root.timedtext, 0);
  return cues;
}

export function parseTranscript(text: string, format?: Format): Cue[] {
  if (typeof text !== 'string' || !text.trim()) throw new Error('字幕内容为空。');
  if (
    text.length > MAX_INPUT_LENGTH ||
    new TextEncoder().encode(text).byteLength > MAX_INPUT_LENGTH
  )
    throw new Error('字幕文件超过 10 MB，请拆分后导入。');
  const input = text.replace(/^\uFEFF/, '').trim();
  const detected =
    format ??
    (input.startsWith('{')
      ? 'json3'
      : input.startsWith('<')
        ? 'xml'
        : input.startsWith('WEBVTT')
          ? 'vtt'
          : 'srt');
  const raw =
    detected === 'json3'
      ? parseJson3(input)
      : detected === 'xml'
        ? parseXml(input)
        : parseTimedText(input, detected);
  const cues = normalizeCues(raw);
  if (!cues.length) throw new Error('字幕中没有可读取的文本，请选择另一条字幕轨道或导入有效文件。');
  return cues;
}

/** Latest-start active cue, or -1 in a gap. Input must be sorted by start (as normalizeCues returns). */
export function findCueIndex(cues: Cue[], time: number): number {
  if (!Number.isFinite(time) || time < 0) return -1;
  let low = 0;
  let high = cues.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (cues[middle]!.start <= time) low = middle + 1;
    else high = middle;
  }
  for (let index = low - 1; index >= 0; index--) {
    if (time < cues[index]!.end) return index;
  }
  return -1;
}

/** Soft character limit: oversized cues stay intact in their own chunk, preserving text and IDs. */
export function chunkCues(cues: Cue[], maxChars = 12_000): Cue[][] {
  if (!Number.isFinite(maxChars) || maxChars < 1) throw new Error('字幕分块大小必须大于零。');
  const chunks: Cue[][] = [];
  let chunk: Cue[] = [];
  let size = 0;
  for (const cue of cues) {
    if (chunk.length && size + cue.text.length + 1 > maxChars) {
      chunks.push(chunk);
      chunk = [];
      size = 0;
    }
    chunk.push(cue);
    size += cue.text.length + 1;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

export function formatTime(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.floor(Math.max(0, seconds)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}
