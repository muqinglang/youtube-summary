import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, PDFString, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { ExportDocument } from '../shared/types';
import { createdLabel, sourceUrl, validateDocument, validTime } from './exports';
import { formatTime } from './transcript';

// A4 at 72dpi, matching the print stylesheet's `@page { size: A4 }`.
const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = { top: 58, bottom: 56, left: 54, right: 54 };
const CONTENT_WIDTH = PAGE.width - MARGIN.left - MARGIN.right;

const INK = rgb(0.125, 0.137, 0.149);
const MUTED = rgb(0.325, 0.361, 0.38);
const RULE = rgb(0.792, 0.827, 0.851);
const LINK = rgb(0.192, 0.365, 0.471);
const WASH = rgb(0.957, 0.969, 0.976);

/** A line may not open with these, so a break before one is pushed back a token. */
const NO_LINE_START = '。，、；：！？）〕］｝」』》〉】…—·%‰"\'’”,.;:!?)]}>';
/** A line may not end with these, so a break after one is pulled forward a token. */
const NO_LINE_END = '（〔［｛「『《〈【“‘"\'([{<';

/**
 * Chinese has no word spaces, so wrapping happens per character; Latin runs and numbers stay
 * whole. Returning tokens rather than characters keeps `2026-09-08` and `GPT-4.1` intact.
 */
function tokenize(text: string): string[] {
  return text.match(/[A-Za-z0-9]+(?:[.'’\-/][A-Za-z0-9]+)*|[^\S\n]+|[\s\S]/g) ?? [];
}

interface Style {
  size: number;
  lineHeight: number;
  color?: ReturnType<typeof rgb>;
  bold?: boolean;
}

export interface PdfOptions {
  /** Bytes of an OpenType/TrueType font that covers the document's characters. */
  font: Uint8Array;
}

class Writer {
  private page: PDFPage;
  private y: number;
  private readonly pages: PDFPage[] = [];
  private supported = new Set<number>();

  constructor(
    private readonly pdf: PDFDocument,
    private readonly font: PDFFont,
  ) {
    for (const code of font.getCharacterSet()) this.supported.add(code);
    this.page = this.newPage();
    this.y = PAGE.height - MARGIN.top;
  }

  private newPage(): PDFPage {
    const page = this.pdf.addPage([PAGE.width, PAGE.height]);
    this.pages.push(page);
    return page;
  }

  /** A glyph the subset lacks would render as tofu; dropping it is the lesser evil. */
  private clean(text: string): string {
    let output = '';
    for (const character of text) {
      const code = character.codePointAt(0)!;
      if (character === '\n' || this.supported.has(code)) output += character;
    }
    return output;
  }

  private width(text: string, size: number): number {
    return this.font.widthOfTextAtSize(text, size);
  }

  /** Greedy fill with the standard CJK line-start / line-end punctuation corrections. */
  private wrap(text: string, size: number, maxWidth: number): string[] {
    const lines: string[] = [];
    for (const paragraph of text.split('\n')) {
      const tokens = tokenize(paragraph);
      let line = '';
      for (const token of tokens) {
        const candidate = line + token;
        if (line && this.width(candidate, size) > maxWidth) {
          let head = line;
          let carry = token;
          const last = [...head].at(-1) ?? '';
          if (NO_LINE_START.includes(token) && [...head].length > 1) {
            head = head.slice(0, head.length - last.length);
            carry = last + token;
          } else if (NO_LINE_END.includes(last) && [...head].length > 1) {
            head = head.slice(0, head.length - last.length);
            carry = last + token;
          }
          lines.push(head.trimEnd());
          line = carry.trimStart();
        } else line = candidate;
      }
      lines.push(line.trimEnd());
    }
    return lines;
  }

  private ensure(height: number): void {
    if (this.y - height >= MARGIN.bottom) return;
    this.page = this.newPage();
    this.y = PAGE.height - MARGIN.top;
  }

  gap(height: number): void {
    this.y -= height;
  }

  rule(): void {
    this.ensure(12);
    this.y -= 8;
    this.page.drawLine({
      start: { x: MARGIN.left, y: this.y },
      end: { x: PAGE.width - MARGIN.right, y: this.y },
      thickness: 0.8,
      color: RULE,
    });
    this.y -= 12;
  }

  /** Returns the drawn box so callers can attach a link annotation to it. */
  text(
    raw: string,
    style: Style,
    options: { indent?: number; width?: number; link?: string } = {},
  ): void {
    const text = this.clean(raw);
    if (!text.trim()) return;
    const indent = options.indent ?? 0;
    const maxWidth = options.width ?? CONTENT_WIDTH - indent;
    const color = style.color ?? INK;
    for (const line of this.wrap(text, style.size, maxWidth)) {
      this.ensure(style.lineHeight);
      this.y -= style.lineHeight;
      const x = MARGIN.left + indent;
      this.page.drawText(line, { x, y: this.y, size: style.size, font: this.font, color });
      // One font weight is bundled, so headings are emboldened by a hairline second pass.
      if (style.bold)
        this.page.drawText(line, {
          x: x + 0.28,
          y: this.y,
          size: style.size,
          font: this.font,
          color,
        });
      if (options.link) {
        const width = this.width(line, style.size);
        this.annotate(x, this.y - 2, x + width, this.y + style.size, options.link);
      }
    }
  }

  /** Draws a label inline and returns the x offset just after it. */
  inline(raw: string, style: Style, x: number, link?: string): number {
    const text = this.clean(raw);
    const width = this.width(text, style.size);
    this.page.drawText(text, {
      x,
      y: this.y,
      size: style.size,
      font: this.font,
      color: style.color ?? INK,
    });
    if (link) this.annotate(x, this.y - 2, x + width, this.y + style.size, link);
    return x + width;
  }

  /** Reserves one line and returns its baseline, for rows built from several runs. */
  row(lineHeight: number): number {
    this.ensure(lineHeight);
    this.y -= lineHeight;
    return this.y;
  }

  bullet(raw: string, style: Style, indent: number): void {
    const marker = 12;
    const before = this.y;
    this.text(raw, style, { indent: indent + marker });
    this.page.drawCircle({
      x: MARGIN.left + indent + 4,
      y: before - style.lineHeight + style.size * 0.34,
      size: 1.5,
      color: MUTED,
    });
  }

  block(raw: string, style: Style): void {
    const text = this.clean(raw);
    const lines = this.wrap(text, style.size, CONTENT_WIDTH - 24);
    const height = lines.length * style.lineHeight + 18;
    this.ensure(height);
    this.page.drawRectangle({
      x: MARGIN.left,
      y: this.y - height,
      width: CONTENT_WIDTH,
      height,
      color: WASH,
      borderColor: RULE,
      borderWidth: 0.6,
    });
    this.y -= 12;
    for (const line of lines) {
      this.y -= style.lineHeight;
      this.page.drawText(line, {
        x: MARGIN.left + 12,
        y: this.y,
        size: style.size,
        font: this.font,
        color: style.color ?? MUTED,
      });
    }
    this.y -= 6;
  }

  private annotate(x1: number, y1: number, x2: number, y2: number, uri: string): void {
    const annotation = this.pdf.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [x1, y1, x2, y2],
      Border: [0, 0, 0],
      A: { Type: 'Action', S: 'URI', URI: PDFString.of(uri) },
    });
    this.page.node.addAnnot(this.pdf.context.register(annotation));
  }

  /** Page numbers can only be written once the total is known. */
  paginate(): void {
    const total = this.pages.length;
    this.pages.forEach((page, index) => {
      const label = `${index + 1} / ${total}`;
      const size = 8.5;
      page.drawText(label, {
        x: PAGE.width - MARGIN.right - this.width(label, size),
        y: MARGIN.bottom - 22,
        size,
        font: this.font,
        color: MUTED,
      });
    });
    const note = '由旁听生成 · 时间点可点击返回视频对应位置';
    this.pages.forEach((page) => {
      page.drawText(this.clean(note), {
        x: MARGIN.left,
        y: MARGIN.bottom - 22,
        size: 8.5,
        font: this.font,
        color: MUTED,
      });
    });
  }
}

const TITLE: Style = { size: 21, lineHeight: 29, bold: true };
const BRAND: Style = { size: 8.5, lineHeight: 13, color: MUTED };
const META: Style = { size: 9.5, lineHeight: 15, color: MUTED };
const H2: Style = { size: 14, lineHeight: 22, bold: true };
const H3: Style = { size: 11.5, lineHeight: 18, bold: true };
const BODY: Style = { size: 10.5, lineHeight: 18 };
const MONO: Style = { size: 9.5, lineHeight: 16, color: MUTED };
const STAMP: Style = { size: 9.5, lineHeight: 18, color: LINK };

/**
 * Renders the notes as a real PDF with selectable, searchable text. The browser print dialog is
 * the only other way an extension can produce a PDF, and it cannot be driven from script.
 */
export async function buildPdf(doc: ExportDocument, options: PdfOptions): Promise<Uint8Array> {
  validateDocument(doc);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(options.font, { subset: true });
  const { summary, video } = doc;
  const source = sourceUrl(doc);

  pdf.setTitle(summary.title);
  pdf.setAuthor(video.author || 'YouTube');
  pdf.setCreator('Sidenote 旁听');
  pdf.setSubject(video.title);

  const writer = new Writer(pdf, font);
  writer.text('SIDENOTE / 旁听 · 视频学习笔记', BRAND);
  writer.gap(6);
  writer.text(summary.title, TITLE);
  writer.gap(8);
  writer.text(`视频：${video.title}`, META);
  writer.text(`作者：${video.author || 'YouTube'}`, META);
  if (source) {
    writer.row(META.lineHeight);
    const after = writer.inline('来源：', META, MARGIN.left);
    writer.inline(source, { ...META, color: LINK }, after, source);
  } else writer.text('来源：无有效视频链接', META);
  writer.text(`生成时间：${createdLabel(doc.createdAt)}`, META);
  writer.rule();

  writer.gap(6);
  writer.text('内容概览', H2);
  writer.gap(2);
  writer.text(summary.overview, BODY);

  writer.gap(16);
  writer.text('章节总结', H2);
  for (const section of summary.sections) {
    writer.gap(8);
    const timed = validTime(section.start);
    const href = timed ? sourceUrl(doc, section.start) : undefined;
    writer.row(H3.lineHeight);
    let x = MARGIN.left;
    if (timed) x = writer.inline(`${formatTime(section.start)}  `, STAMP, x, href);
    writer.inline(section.title, H3, x);
    writer.gap(2);
    for (const point of section.points) writer.bullet(point, BODY, 4);
  }

  if (summary.takeaways.length) {
    writer.gap(16);
    writer.text('行动与启发', H2);
    writer.gap(2);
    for (const takeaway of summary.takeaways) writer.bullet(takeaway, BODY, 4);
  }

  if (doc.prompt.trim()) {
    writer.gap(16);
    writer.text('总结提示词', H2);
    writer.gap(4);
    writer.block(doc.prompt, MONO);
  }

  writer.paginate();
  return pdf.save();
}
