import { readZip } from "./zip.js";

// The text inside a Word, Excel or PowerPoint file (phase 22), so the chat can
// read what people attach: Claude's Read tool opens text, images and PDFs, not
// Office files. Word → paragraphs (headings marked), Excel → one CSV block per
// sheet, PowerPoint → the text of each slide. Read straight from the file's XML.

export type OfficeKind = "docx" | "xlsx" | "pptx";
export const OFFICE_KINDS: OfficeKind[] = ["docx", "xlsx", "pptx"];

const MAX_SHEET_ROWS = 2_000;
const MAX_CHARS = 400_000;

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return XML_ENTITIES[e.toLowerCase()] ?? "";
  });
}

/** The text of an Office file as Markdown-ish plain text. Throws when the file
 * isn't a readable Office document. */
export function officeText(kind: OfficeKind, data: Buffer): string {
  const files = readZip(data);
  const read = (name: string) => files.get(name)?.().toString("utf8") ?? null;
  const text = kind === "docx" ? wordText(read) : kind === "xlsx" ? workbookText(read, [...files.keys()]) : slidesText(read, [...files.keys()]);
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n\n[Cut off here: the file has more text than tethr reads.]\n` : text;
}

type ReadPart = (name: string) => string | null;

/** Each table as a Markdown table (one synthetic paragraph): the first row is
 * the header, cells are joined with " | " and their own pipes escaped. */
function flattenTables(xml: string): string {
  return xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, (table) => {
    const rows = [...table.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((row) =>
      [...row[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((cell) =>
        [...cell[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
          .map((t) => t[1])
          .join(" ")
          .replace(/\|/g, "\\|")
          .trim(),
      ),
    );
    if (!rows.length) return "";
    const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
    const header = [line(rows[0]), line(rows[0].map(() => "---"))];
    return `<w:p><w:r><w:t>${[...header, ...rows.slice(1).map(line)].join("\n")}</w:t></w:r></w:p>`;
  });
}

function wordText(read: ReadPart): string {
  const raw = read("word/document.xml");
  if (raw === null) throw new Error("this isn't a Word document");
  const xml = flattenTables(raw);
  const lines: string[] = [];
  // <w:p …>…</w:p> (not <w:pPr>: \b needs a non-word character after "p").
  for (const para of xml.matchAll(/<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g)) {
    const body = para[1] ?? "";
    let text = "";
    for (const piece of body.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:(?:br|cr)\/>/g)) {
      text += piece[0].startsWith("<w:tab") ? "\t" : piece[1] === undefined ? "\n" : piece[1];
    }
    text = unescapeXml(text);
    const style = /<w:pStyle w:val="([^"]+)"/.exec(body)?.[1] ?? "";
    const level = style === "Title" ? 1 : Number(/^heading\s?(\d)$/i.exec(style)?.[1] ?? 0);
    lines.push(level && text.trim() ? `${"#".repeat(Math.min(6, level))} ${text.trim()}` : text);
  }
  return collapse(lines.join("\n"));
}

function workbookText(read: ReadPart, names: string[]): string {
  const workbook = read("xl/workbook.xml");
  if (workbook === null) throw new Error("this isn't an Excel workbook");
  const shared = sharedStrings(read("xl/sharedStrings.xml"));
  const rels = read("xl/_rels/workbook.xml.rels") ?? "";
  const targets = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], "Id"), attr(m[0], "Target")]));
  const sheets = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({ name: unescapeXml(attr(m[0], "name")), rid: attr(m[0], "r:id") }));
  const blocks: string[] = [];
  sheets.forEach((sheet, i) => {
    const target = (targets.get(sheet.rid) ?? `worksheets/sheet${i + 1}.xml`).replace(/^\/?xl\//, "").replace(/^\//, "");
    const xml = read(`xl/${target}`) ?? (names.includes(`xl/worksheets/sheet${i + 1}.xml`) ? read(`xl/worksheets/sheet${i + 1}.xml`) : null);
    if (xml === null) return;
    const { rows, cut } = sheetRows(xml, shared);
    blocks.push(`## Sheet: ${sheet.name}\n${rows.map(csvLine).join("\n")}${cut ? `\n[Only the first ${MAX_SHEET_ROWS} rows.]` : ""}`);
  });
  return blocks.join("\n\n") + "\n";
}

function sharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unescapeXml([...m[1].matchAll(/<t(?: [^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")));
}

function sheetRows(xml: string, shared: string[]): { rows: string[][]; cut: boolean } {
  const rows: string[][] = [];
  let cut = false;
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (rows.length >= MAX_SHEET_ROWS) {
      cut = true;
      break;
    }
    const row: string[] = [];
    for (const cell of rowMatch[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1];
      const body = cell[2] ?? "";
      const ref = attr(attrs, "r");
      const col = ref ? columnIndex(ref) : row.length;
      const type = attr(attrs, "t");
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value = "";
      if (type === "s" && v !== undefined) value = shared[Number(v)] ?? "";
      else if (type === "inlineStr") value = unescapeXml([...body.matchAll(/<t(?: [^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""));
      else if (type === "b") value = v === "1" ? "TRUE" : "FALSE";
      else if (v !== undefined) value = unescapeXml(v);
      row[col] = value;
    }
    rows.push(Array.from(row, (c) => c ?? ""));
  }
  return { rows: rows.filter((r) => r.some((c) => c.trim() !== "")), cut };
}

function slidesText(read: ReadPart, names: string[]): string {
  const slides = names
    .map((n) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(n))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  if (!slides.length) throw new Error("this isn't a PowerPoint deck");
  return (
    slides
      .map((m) => {
        const xml = read(m[0]) ?? "";
        const paras = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)]
          .map((p) => unescapeXml([...p[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => t[1]).join("")).trim())
          .filter(Boolean);
        return `## Slide ${m[1]}\n${paras.join("\n")}`;
      })
      .join("\n\n") + "\n"
  );
}

function attr(tag: string, name: string): string {
  const m = new RegExp(`\\s${name.replace(":", "\\:")}="([^"]*)"`).exec(tag);
  return m ? m[1] : "";
}

/** "C7" → 2. */
function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function csvLine(row: string[]): string {
  return row.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",");
}

function collapse(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
