import path from "node:path";
import { writeNewFile } from "../atomic.js";
import { parseCsv } from "../csv.js";
import { csvCells, DOCUMENT_FORMATS, renderDocument, renderWorkbook, WORKBOOK_LIMITS, type Cell, type DocumentFormat, type Sheet } from "../documents.js";
import { readTextInFiles, safeFileName } from "./files.js";
import { FILES_DIR } from "./workspace.js";

// make_document (phase 22): the chat's way to make real files (PDF, Word,
// PowerPoint, Excel, HTML) in its files/ folder. It runs in the tethr server, so
// the chat needs no shell; the renderers are in documents.ts.

export const MAKE_DOCUMENT_LIMITS = { markdownChars: 400_000, sourceBytes: 4_000_000 };

const ALIASES: Record<string, DocumentFormat> = {
  pdf: "pdf",
  docx: "docx",
  word: "docx",
  doc: "docx",
  pptx: "pptx",
  powerpoint: "pptx",
  slides: "pptx",
  deck: "pptx",
  xlsx: "xlsx",
  excel: "xlsx",
  spreadsheet: "xlsx",
  workbook: "xlsx",
  html: "html",
  web: "html",
};

export const FORMAT_LABEL: Record<DocumentFormat, string> = {
  pdf: "PDF",
  docx: "Word document",
  pptx: "PowerPoint deck",
  xlsx: "Excel workbook",
  html: "web page",
};

export const MAKE_DOCUMENT_DEF = {
  name: "make_document",
  description:
    "Make a real document in ./files/: a PDF, a Word document (docx), a PowerPoint deck (pptx), an Excel workbook (xlsx) or a standalone web page (html). Use this for any of those formats instead of writing scripts. For pdf, docx, pptx and html, give the body as Markdown (headings, lists, tables, bold, links) or from_file (a .md or .txt in ./files/); in a deck each ## heading starts a slide. For xlsx, give sheets ([{name, rows}], first row is the header) or from_file (a .csv in ./files/). Saves under a new name (never overwrites) and returns the path; the file opens in the side panel.",
  inputSchema: {
    type: "object",
    properties: {
      format: { type: "string", enum: [...DOCUMENT_FORMATS], description: "pdf, docx, pptx, xlsx or html" },
      title: { type: "string", description: "The document's title (shown at the top, and the default file name)" },
      markdown: { type: "string", description: "The body in Markdown (pdf, docx, pptx, html)" },
      sheets: {
        type: "array",
        description: "For xlsx: one entry per sheet. rows is a list of rows; the first row is the header.",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            rows: { type: "array", items: { type: "array", items: { type: ["string", "number", "boolean", "null"] } } },
          },
          required: ["rows"],
        },
      },
      from_file: { type: "string", description: "Instead of markdown/sheets: a .md/.txt (documents) or .csv (xlsx) already in ./files/" },
      subtitle: { type: "string", description: "Optional small line under the title, e.g. the company and date" },
      save_as: { type: "string", description: "File name in ./files/ (the extension is set for you)" },
    },
    required: ["format", "title"],
  },
};

export type MakeDocumentResult = { rel: string; format: DocumentFormat; title: string; bytes: number } | { error: string };

/** Make the document and save it in files/. */
export async function makeDocument(args: Record<string, unknown>, ctx: { workspaceDir: string; now?: () => Date }): Promise<MakeDocumentResult> {
  const format = ALIASES[String(args.format ?? "").trim().toLowerCase()];
  if (!format) return { error: `format must be one of ${DOCUMENT_FORMATS.join(", ")}.` };
  const title = typeof args.title === "string" && args.title.trim() ? args.title.trim().slice(0, 200) : "";
  if (!title) return { error: "give the document a title." };
  const now = ctx.now?.() ?? new Date();

  let data: Buffer;
  if (format === "xlsx") {
    const sheets = await sheetsFrom(args, ctx.workspaceDir);
    if ("error" in sheets) return sheets;
    data = renderWorkbook(sheets, now);
  } else {
    const body = await markdownFrom(args, ctx.workspaceDir);
    if ("error" in body) return body;
    const subtitle = typeof args.subtitle === "string" && args.subtitle.trim() ? args.subtitle.trim().slice(0, 200) : undefined;
    try {
      data = await renderDocument(format, { title, markdown: body.markdown, meta: subtitle });
    } catch (err) {
      return { error: `couldn't make the ${FORMAT_LABEL[format]} (${err instanceof Error ? err.message : String(err)}).` };
    }
  }

  const name = safeFileName(typeof args.save_as === "string" && args.save_as.trim() ? args.save_as : title, format, "document");
  const used = await writeNewFile(path.join(ctx.workspaceDir, FILES_DIR), name, data);
  return { rel: `${FILES_DIR}/${used}`, format, title, bytes: data.length };
}

async function markdownFrom(args: Record<string, unknown>, workspaceDir: string): Promise<{ markdown: string } | { error: string }> {
  if (typeof args.from_file === "string" && args.from_file.trim()) {
    const ext = path.extname(args.from_file.trim()).toLowerCase();
    if (![".md", ".markdown", ".txt"].includes(ext)) return { error: "from_file must be a .md or .txt file for this format." };
    const file = await readTextInFiles(workspaceDir, args.from_file, MAKE_DOCUMENT_LIMITS.sourceBytes, "from_file");
    return "error" in file ? file : { markdown: file.text.slice(0, MAKE_DOCUMENT_LIMITS.markdownChars) };
  }
  if (typeof args.markdown === "string" && args.markdown.trim()) return { markdown: args.markdown.slice(0, MAKE_DOCUMENT_LIMITS.markdownChars) };
  return { error: "give the body as markdown, or from_file." };
}

async function sheetsFrom(args: Record<string, unknown>, workspaceDir: string): Promise<Sheet[] | { error: string }> {
  if (typeof args.from_file === "string" && args.from_file.trim()) {
    if (path.extname(args.from_file.trim()).toLowerCase() !== ".csv") return { error: "from_file must be a .csv file for a workbook." };
    const file = await readTextInFiles(workspaceDir, args.from_file, MAKE_DOCUMENT_LIMITS.sourceBytes, "from_file");
    if ("error" in file) return file;
    const rows = parseCsv(file.text).map(csvCells);
    if (!rows.length) return { error: `${file.rel} is empty.` };
    return [{ name: path.basename(file.rel, ".csv"), rows }];
  }
  if (!Array.isArray(args.sheets) || !args.sheets.length) return { error: "give sheets ([{name, rows}]) or from_file (a .csv)." };
  const sheets: Sheet[] = [];
  for (const [i, raw] of args.sheets.slice(0, WORKBOOK_LIMITS.sheets).entries()) {
    const sheet = raw as { name?: unknown; rows?: unknown };
    if (!sheet || !Array.isArray(sheet.rows)) return { error: `sheet ${i + 1} needs rows (a list of rows).` };
    const rows = sheet.rows.map((row) => (Array.isArray(row) ? row.map(toCell) : [toCell(row)]));
    sheets.push({ name: typeof sheet.name === "string" ? sheet.name : `Sheet${i + 1}`, rows });
  }
  return sheets;
}

function toCell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") return value;
  return JSON.stringify(value);
}
