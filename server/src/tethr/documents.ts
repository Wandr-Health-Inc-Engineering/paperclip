import type { Token, Tokens } from "marked";
import { writeZip } from "./zip.js";

// Real documents from Markdown (phase 22): PDF, Word, PowerPoint and HTML, plus
// Excel workbooks from rows. Used by the chat's make_document tool and the Drive
// mirror. Libraries load on demand (marked + Playwright for PDF, docx, pptxgenjs);
// Excel needs none (zip.ts).

export type DocumentFormat = "pdf" | "docx" | "pptx" | "html" | "xlsx";
export const DOCUMENT_FORMATS: DocumentFormat[] = ["pdf", "docx", "pptx", "html", "xlsx"];

export interface DocumentInput {
  title: string;
  /** The body, in Markdown. */
  markdown: string;
  /** A small line under the title (who and when). Optional. */
  meta?: string;
}

export type Cell = string | number | boolean | null;
export interface Sheet {
  name: string;
  /** The first row is the header (bold, frozen). */
  rows: Cell[][];
}

/** Render Markdown to a PDF, Word, PowerPoint or HTML file. */
export async function renderDocument(format: Exclude<DocumentFormat, "xlsx">, input: DocumentInput): Promise<Buffer> {
  switch (format) {
    case "pdf":
      return renderPdf(input);
    case "docx":
      return renderDocx(input);
    case "pptx":
      return renderPptx(input);
    case "html":
      return Buffer.from(await renderHtml(input), "utf8");
  }
}

// ---- HTML and PDF ----------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A standalone, printable page: black on white, system fonts, thin rules. */
export async function renderHtml(input: DocumentInput): Promise<string> {
  const { marked } = await import("marked");
  const body = await marked.parse(input.markdown, { async: true });
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(input.title)}</title><style>
  @page { margin: 20mm 18mm; }
  body { font-family: -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif; color: #111; font-size: 11pt; line-height: 1.55; max-width: 46em; margin: 0 auto; }
  h1 { font-size: 22pt; font-weight: 500; letter-spacing: -0.01em; margin: 0 0 4pt; }
  h2 { font-size: 14pt; font-weight: 500; margin: 18pt 0 6pt; }
  h3 { font-size: 12pt; font-weight: 500; margin: 14pt 0 4pt; }
  .meta { font-family: ui-monospace, Menlo, monospace; font-size: 8.5pt; color: #555; margin-bottom: 16pt; padding-bottom: 8pt; border-bottom: 1px solid #111; }
  table { border-collapse: collapse; width: 100%; margin: 10pt 0; }
  th, td { border: 1px solid #bbb; padding: 4pt 6pt; text-align: left; vertical-align: top; font-size: 10pt; }
  th { background: #f2f2f2; font-weight: 500; }
  code, pre { font-family: ui-monospace, Menlo, monospace; font-size: 9.5pt; background: #f4f4f4; }
  pre { padding: 8pt; white-space: pre-wrap; }
  blockquote { border-left: 2px solid #111; margin-left: 0; padding-left: 10pt; color: #333; }
  img { max-width: 100%; }
  a { color: #111; }
  </style></head><body><h1>${escapeHtml(input.title)}</h1>${input.meta ? `<div class="meta">${escapeHtml(input.meta)}</div>` : ""}${body}</body></html>`;
}

/** Print the HTML page to a Letter PDF in headless Chromium, with JavaScript
 * off and every network request refused: a document can't run code or reach
 * anything (only inline data: images load). */
async function renderPdf(input: DocumentInput): Promise<Buffer> {
  // Outside images can't load here (network is off), so don't print broken-image boxes.
  const html = (await renderHtml(input)).replace("</style>", 'img:not([src^="data:"]) { display: none; }\n  </style>');
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false, offline: true });
    await context.route("**/*", (route) => (route.request().url().startsWith("data:") ? route.continue() : route.abort()));
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "load" });
    return Buffer.from(await page.pdf({ format: "Letter", printBackground: true }));
  } finally {
    await browser.close();
  }
}

// ---- Word ------------------------------------------------------------------

type DocxModule = typeof import("docx");
type InlineStyle = { bold?: boolean; italics?: boolean; strike?: boolean; underline?: boolean; code?: boolean };

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m);

/** A Word document built from the Markdown's structure: headings, paragraphs
 * with bold/italic/code/links, bullet and numbered lists, tables, quotes, code. */
async function renderDocx(input: DocumentInput): Promise<Buffer> {
  const docx = await import("docx");
  const { marked } = await import("marked");
  const builder = new DocxBuilder(docx);
  const children = [
    new docx.Paragraph({ text: input.title, heading: docx.HeadingLevel.TITLE }),
    ...(input.meta ? [new docx.Paragraph({ children: [new docx.TextRun({ text: input.meta, font: "Menlo", size: 16, color: "555555" })] })] : []),
    ...builder.blocks(marked.lexer(input.markdown)),
  ];
  const doc = new docx.Document({
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    numbering: { config: [{ reference: "numbered", levels: numberedLevels(docx) }] },
    sections: [{ children }],
  });
  return docx.Packer.toBuffer(doc);
}

function numberedLevels(docx: DocxModule) {
  return [0, 1, 2].map((level) => ({
    level,
    format: docx.LevelFormat.DECIMAL,
    text: `%${level + 1}.`,
    alignment: docx.AlignmentType.START,
    style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
  }));
}

type DocxBlock = InstanceType<DocxModule["Paragraph"]> | InstanceType<DocxModule["Table"]>;

/** Letter page width less 1-inch margins, in twentieths of a point. */
const PAGE_TEXT_WIDTH = 9360;

/** Raw HTML in Markdown as plain text: scripts and styles dropped with their contents. */
function stripHtml(html: string): string {
  return html.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "").replace(/<[^>]+>/g, "");
}

class DocxBuilder {
  private listInstance = 0;
  constructor(private readonly docx: DocxModule) {}

  blocks(tokens: Token[], quote = false): DocxBlock[] {
    return tokens.flatMap((token) => this.block(token, quote));
  }

  private block(token: Token, quote: boolean): DocxBlock[] {
    const { Paragraph, HeadingLevel } = this.docx;
    const indent = quote ? { left: 480 } : undefined;
    switch (token.type) {
      case "heading": {
        const levels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
        const t = token as Tokens.Heading;
        return [new Paragraph({ heading: levels[Math.min(t.depth, 6) - 1], children: this.runs(t.tokens) })];
      }
      case "paragraph":
        return [new Paragraph({ indent, children: this.runs((token as Tokens.Paragraph).tokens, quote ? { italics: true } : {}) })];
      case "list":
        return this.list(token as Tokens.List, 0);
      case "table":
        return [this.table(token as Tokens.Table)];
      case "code":
        return (token as Tokens.Code).text.split("\n").map(
          (line) => new Paragraph({ shading: { type: this.docx.ShadingType.CLEAR, fill: "F4F4F4", color: "auto" }, children: [this.text(line || " ", { code: true })] }),
        );
      case "blockquote":
        return this.blocks((token as Tokens.Blockquote).tokens, true);
      case "hr":
        return [new Paragraph({ border: { bottom: { style: this.docx.BorderStyle.SINGLE, size: 6, color: "999999", space: 1 } }, children: [] })];
      case "space":
        return [];
      case "html": {
        const text = decode(stripHtml((token as Tokens.HTML).text)).trim();
        return text ? [new Paragraph({ children: [this.text(text)] })] : [];
      }
      default:
        return "text" in token && typeof token.text === "string" ? [new Paragraph({ indent, children: [this.text(decode(token.text))] })] : [];
    }
  }

  private list(list: Tokens.List, level: number): DocxBlock[] {
    const { Paragraph } = this.docx;
    const instance = ++this.listInstance;
    const out: DocxBlock[] = [];
    for (const item of list.items) {
      const inline = item.tokens.filter((t) => t.type !== "list");
      const runs = inline.flatMap((t) => (t.type === "text" || t.type === "paragraph" ? this.runs((t as Tokens.Text).tokens ?? [t]) : []));
      const prefix = item.task ? [this.text(item.checked ? "[x] " : "[ ] ")] : [];
      out.push(
        list.ordered
          ? new Paragraph({ numbering: { reference: "numbered", level: Math.min(level, 2), instance }, children: [...prefix, ...runs] })
          : new Paragraph({ bullet: { level: Math.min(level, 2) }, children: [...prefix, ...runs] }),
      );
      for (const nested of item.tokens.filter((t) => t.type === "list")) out.push(...this.list(nested as Tokens.List, level + 1));
    }
    return out;
  }

  /** A table across the page, columns split evenly (widths in twentieths of a
   * point; without them some readers collapse every column). */
  private table(table: Tokens.Table): DocxBlock {
    const { Table, TableRow, TableCell, Paragraph, WidthType } = this.docx;
    const columns = Math.max(1, table.header.length);
    const columnWidth = Math.floor(PAGE_TEXT_WIDTH / columns);
    const row = (cells: Tokens.TableCell[], header: boolean) =>
      new TableRow({
        tableHeader: header,
        children: cells.map(
          (cell) =>
            new TableCell({
              width: { size: columnWidth, type: WidthType.DXA },
              shading: header ? { type: this.docx.ShadingType.CLEAR, fill: "F2F2F2", color: "auto" } : undefined,
              children: [new Paragraph({ children: this.runs(cell.tokens, header ? { bold: true } : {}) })],
            }),
        ),
      });
    return new Table({
      width: { size: columnWidth * columns, type: WidthType.DXA },
      columnWidths: Array.from({ length: columns }, () => columnWidth),
      rows: [row(table.header, true), ...table.rows.map((r) => row(r, false))],
    });
  }

  /** Inline tokens as text runs, carrying bold/italic/strike/code down nested emphasis. */
  private runs(tokens: Token[] | undefined, style: InlineStyle = {}): InstanceType<DocxModule["TextRun"]>[] {
    return (tokens ?? []).flatMap((t) => {
      switch (t.type) {
        case "strong":
          return this.runs((t as Tokens.Strong).tokens, { ...style, bold: true });
        case "em":
          return this.runs((t as Tokens.Em).tokens, { ...style, italics: true });
        case "del":
          return this.runs((t as Tokens.Del).tokens, { ...style, strike: true });
        case "codespan":
          return [this.text(decode((t as Tokens.Codespan).text), { ...style, code: true })];
        case "link": {
          const link = t as Tokens.Link;
          const label = this.runs(link.tokens, { ...style, underline: true });
          return link.href && link.href !== link.text ? [...label, this.text(` (${link.href})`, style)] : label;
        }
        case "br":
          return [new this.docx.TextRun({ break: 1 })];
        case "text": {
          const text = t as Tokens.Text;
          return text.tokens?.length ? this.runs(text.tokens, style) : [this.text(decode(text.text), style)];
        }
        default:
          return "text" in t && typeof t.text === "string" ? [this.text(decode(t.text), style)] : [];
      }
    });
  }

  private text(text: string, style: InlineStyle = {}) {
    return new this.docx.TextRun({
      text,
      bold: style.bold,
      italics: style.italics,
      strike: style.strike,
      underline: style.underline ? {} : undefined,
      font: style.code ? "Menlo" : undefined,
    });
  }
}

// ---- PowerPoint ------------------------------------------------------------

/** A title slide, then one slide per `##` section with its lines as bullets
 * (Markdown emphasis stripped; slide text is plain). */
async function renderPptx(input: DocumentInput): Promise<Buffer> {
  const mod = (await import("pptxgenjs")) as unknown as { default: new () => import("pptxgenjs").default };
  const pptx = new mod.default();
  pptx.defineLayout({ name: "WIDE", width: 13.33, height: 7.5 });
  pptx.layout = "WIDE";
  const font = "Helvetica Neue";
  const strip = (s: string) =>
    decode(s)
      .replace(/\*\*|__|\*|_|`/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/^#+\s*/, "")
      .replace(/^\s*>\s?/, "")
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
      .trim();
  // A table row reads "a · b · c" on a slide.
  const tableRow = (s: string) => (s.includes("|") ? s.replace(/\s*\|\s*/g, " · ").trim().replace(/^·\s*|\s*·$/g, "") : s);

  const title = pptx.addSlide();
  title.background = { color: "FFFFFF" };
  title.addText(input.title, { x: 0.7, y: 2.5, w: 11.9, h: 1.6, fontFace: font, fontSize: 40, bold: true, color: "111111" });
  if (input.meta) title.addText(input.meta, { x: 0.7, y: 4.2, w: 11.9, h: 0.5, fontFace: "Menlo", fontSize: 12, color: "555555" });

  for (const section of input.markdown.split(/\n(?=##\s)/)) {
    // Drop blank lines, table rules (|---|) and code fences (```).
    const lines = section.split("\n").filter((l) => l.trim() && !/^\s*\|?\s*:?-{3,}/.test(l) && !/^\s*(```|~~~)/.test(l));
    if (!lines.length) continue;
    const hasHeading = /^##\s/.test(lines[0]);
    const heading = hasHeading ? strip(lines[0]) : "Overview";
    const bullets = (hasHeading ? lines.slice(1) : lines).map(strip).filter(Boolean).slice(0, 10);
    if (!bullets.length) continue;
    const slide = pptx.addSlide();
    slide.background = { color: "FFFFFF" };
    slide.addText(heading, { x: 0.7, y: 0.45, w: 11.9, h: 0.9, fontFace: font, fontSize: 28, bold: true, color: "111111" });
    slide.addText(
      bullets.map((b) => ({ text: tableRow(b), options: { bullet: true, breakLine: true } })),
      { x: 0.7, y: 1.6, w: 11.9, h: 5.4, fontFace: font, fontSize: 18, color: "111111", valign: "top", paraSpaceAfter: 6 },
    );
  }
  return (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
}

// ---- Excel -----------------------------------------------------------------

export const WORKBOOK_LIMITS = { sheets: 20, rows: 50_000, columns: 200, cellChars: 32_000 };

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function xmlText(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** "A", "B", … "Z", "AA" for a 0-based column. */
export function columnName(index: number): string {
  let n = index + 1;
  let name = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    name = String.fromCharCode(65 + r) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/** Sheet names Excel accepts: at most 31 characters, none of []:*?/\, unique. */
function sheetNames(sheets: Sheet[]): string[] {
  const used = new Set<string>();
  return sheets.map((sheet, i) => {
    const base = (sheet.name || `Sheet${i + 1}`).replace(/[[\]:*?/\\]/g, " ").replace(/^'+|'+$/g, "").slice(0, 31).trim() || `Sheet${i + 1}`;
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base.slice(0, 31 - String(n).length - 1)} ${n}`;
    used.add(name.toLowerCase());
    return name;
  });
}

function cellXml(value: Cell, ref: string, header: boolean): string {
  const style = header ? ' s="1"' : "";
  if (value === null || value === "") return "";
  if (typeof value === "number") return Number.isFinite(value) ? `<c r="${ref}"${style}><v>${value}</v></c>` : "";
  if (typeof value === "boolean") return `<c r="${ref}"${style} t="b"><v>${value ? 1 : 0}</v></c>`;
  // Inline strings are never evaluated, so text that starts with "=" stays text.
  const text = xmlText(String(value).slice(0, WORKBOOK_LIMITS.cellChars));
  return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
}

function sheetXml(rows: Cell[][]): string {
  const widths: number[] = [];
  for (const row of rows.slice(0, 200)) {
    row.forEach((v, c) => {
      widths[c] = Math.max(widths[c] ?? 8, Math.min(60, String(v ?? "").length + 2));
    });
  }
  const cols = widths.length
    ? `<cols>${widths.map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`
    : "";
  const data = rows
    .map((row, r) => `<row r="${r + 1}">${row.map((v, c) => cellXml(v, `${columnName(c)}${r + 1}`, r === 0)).join("")}</row>`)
    .join("");
  const freeze = rows.length > 1 ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : "";
  return `${XML_HEAD}<worksheet xmlns="${NS_MAIN}">${freeze}${cols}<sheetData>${data}</sheetData></worksheet>`;
}

/** An Excel workbook (.xlsx) with one sheet per entry; each first row is a bold,
 * frozen header. Text stays text (never a formula). */
export function renderWorkbook(sheets: Sheet[], now: Date = new Date()): Buffer {
  if (!sheets.length) throw new Error("a workbook needs at least one sheet");
  const list = sheets.slice(0, WORKBOOK_LIMITS.sheets).map((s) => ({
    ...s,
    rows: s.rows.slice(0, WORKBOOK_LIMITS.rows).map((r) => r.slice(0, WORKBOOK_LIMITS.columns)),
  }));
  const names = sheetNames(list);
  const sheetRefs = list.map((_, i) => i + 1);
  const files = [
    {
      name: "[Content_Types].xml",
      xml: `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheetRefs
        .map((n) => `<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join("")}</Types>`,
    },
    {
      name: "_rels/.rels",
      xml: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      xml: `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets>${names
        .map((name, i) => `<sheet name="${xmlText(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join("")}</sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      xml: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRefs
        .map((n) => `<Relationship Id="rId${n}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${n}.xml"/>`)
        .join("")}<Relationship Id="rId${list.length + 1}" Type="${NS_REL}/styles" Target="styles.xml"/></Relationships>`,
    },
    {
      name: "xl/styles.xml",
      xml: `${XML_HEAD}<styleSheet xmlns="${NS_MAIN}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    },
    ...list.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, xml: sheetXml(sheet.rows) })),
  ];
  return writeZip(
    files.map((f) => ({ name: f.name, data: Buffer.from(f.xml, "utf8") })),
    now,
  );
}

/** A CSV row's cells as workbook cells: plain numbers become numbers. */
export function csvCells(row: string[]): Cell[] {
  return row.map((v) => {
    const t = v.trim();
    return /^-?(?:\d+|\d*\.\d+)$/.test(t) && t.length < 16 ? Number(t) : v;
  });
}
