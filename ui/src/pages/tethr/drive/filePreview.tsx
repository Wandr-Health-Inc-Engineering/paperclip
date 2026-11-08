import { useQuery } from "@tanstack/react-query";
import {
  File as FileIcon,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType,
  Folder,
  Presentation,
  type LucideIcon,
} from "lucide-react";
import { MarkdownBody } from "@/components/MarkdownBody";
import { cn } from "@/lib/utils";
import type { DriveSource, FmItem } from "./adapters";

// File-type helpers and the shared preview renderer used by the Finder's
// preview pane and Quick Look. Monochrome glyphs only (brand lock).

function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

const KINDS: Record<string, { label: string; icon: LucideIcon }> = {
  md: { label: "Markdown document", icon: FileText },
  markdown: { label: "Markdown document", icon: FileText },
  txt: { label: "Plain text", icon: FileText },
  html: { label: "HTML document", icon: FileCode },
  htm: { label: "HTML document", icon: FileCode },
  json: { label: "JSON", icon: FileCode },
  command: { label: "Terminal script", icon: FileCode },
  sh: { label: "Shell script", icon: FileCode },
  csv: { label: "CSV spreadsheet", icon: FileSpreadsheet },
  xlsx: { label: "Excel workbook", icon: FileSpreadsheet },
  pdf: { label: "PDF document", icon: FileType },
  docx: { label: "Word document", icon: FileText },
  pptx: { label: "PowerPoint deck", icon: Presentation },
  png: { label: "PNG image", icon: FileImage },
  jpg: { label: "JPEG image", icon: FileImage },
  jpeg: { label: "JPEG image", icon: FileImage },
  gif: { label: "GIF image", icon: FileImage },
  webp: { label: "WebP image", icon: FileImage },
  svg: { label: "SVG image", icon: FileImage },
};

export function fileKind(item: Pick<FmItem, "name" | "kind">): string {
  if (item.kind === "folder") return "Folder";
  const e = ext(item.name);
  return KINDS[e]?.label ?? (e ? `${e.toUpperCase()} file` : "Document");
}

export function FileGlyph({ item, className }: { item: Pick<FmItem, "name" | "kind">; className?: string }) {
  const Icon = item.kind === "folder" ? Folder : (KINDS[ext(item.name)]?.icon ?? FileIcon);
  return <Icon className={cn("shrink-0", className)} strokeWidth={1.5} />;
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes == null) return "--";
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Finder-style date: "Today at 3:12 PM", "Yesterday at …", "Jul 16, 2026 at 4:55 AM". */
export function formatFinderDate(value: string | undefined): string {
  if (!value) return "--";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "--";
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000);
  if (days === 0) return `Today at ${time}`;
  if (days === 1) return `Yesterday at ${time}`;
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `${date} at ${time}`;
}

export function previewQueryKey(source: DriveSource, key: string) {
  return [...source.invalidateKey, "read", key] as const;
}

/** Render a file's contents: Markdown as a document, HTML in a locked-down
 * sandbox (no scripts, no same-origin), other text as monospace. */
export function PreviewBody({
  source,
  item,
  size,
}: {
  source: DriveSource;
  item: FmItem;
  size: "pane" | "full";
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: previewQueryKey(source, item.key),
    queryFn: () => source.read(item.key),
  });
  const e = ext(item.name);
  const full = size === "full";

  if (isLoading) {
    return <p className="px-5 py-6 font-mono text-[11px] tethr-text-3">Reading…</p>;
  }
  if (error || data?.kind === "missing") {
    return <Unpreviewable item={item} text="This file couldn't be read. It may have been moved or renamed." />;
  }
  if (data?.kind === "toolarge") {
    return <Unpreviewable item={item} text="Too large to preview here. Open it in Google Drive or Finder." />;
  }
  if (data?.kind !== "text") {
    return <Unpreviewable item={item} text="No preview for this file type. Open it in Google Drive or Finder." />;
  }

  const content = data.content ?? "";
  if (e === "html" || e === "htm") {
    return (
      <iframe
        title={item.name}
        sandbox=""
        srcDoc={content}
        className="block h-full min-h-[320px] w-full flex-1 border-0 bg-white"
      />
    );
  }
  if (e === "csv") {
    return <CsvTable content={content} full={full} />;
  }
  if (e === "md" || e === "markdown" || !source.isFs) {
    const { meta, body } = splitFrontMatter(content);
    return (
      <div className={cn("mx-auto w-full", full ? "max-w-[70ch] px-6 py-8 md:px-10 md:py-10" : "px-5 py-5")}>
        {meta.length ? (
          <dl className="tethr-inset mb-5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 px-3 py-2.5 font-mono text-[11px]">
            {meta.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="tethr-text-3">{k}</dt>
                <dd className="truncate" title={v}>
                  {v}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        <MarkdownBody className={cn("tethr-doc-md", full ? "tethr-doc-lg" : "tethr-doc-sm")}>{body}</MarkdownBody>
      </div>
    );
  }
  return (
    <div className={cn("w-full", full ? "px-6 py-6 md:px-10" : "p-4")}>
      <pre className="tethr-inset whitespace-pre-wrap break-words p-4 font-mono text-[11.5px] leading-relaxed">{content}</pre>
    </div>
  );
}

/** Split a leading YAML front-matter block ("---" … "---", simple key: value
 * lines, as the Drive mirror writes) from the Markdown body. Anything that
 * isn't a clean block is left in the body untouched. */
export function splitFrontMatter(content: string): { meta: Array<[string, string]>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!m) return { meta: [], body: content };
  const meta: Array<[string, string]> = [];
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const kv = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (!kv) return { meta: [], body: content };
    meta.push([kv[1], kv[2].replace(/^["']|["']$/g, "")]);
  }
  return { meta, body: content.slice(m[0].length) };
}

/** RFC 4180-ish CSV: quoted fields, doubled quotes, CRLF or LF. Blank rows dropped. */
export function parseCsvText(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

const CSV_MAX_ROWS = 500;
const NUMERIC = /^-?\d+(\.\d+)?$/;
/** Tethr writes a leading ' before text a spreadsheet would run as a formula; hide it here. */
const shownCell = (v: string) => (/^'[=+\-@]/.test(v) ? v.slice(1) : v);

/** A CSV as a scrollable table (header row sticky, numbers right-aligned). */
function CsvTable({ content, full }: { content: string; full: boolean }) {
  const rows = parseCsvText(content);
  if (!rows.length) return <p className="px-5 py-6 font-mono text-[11px] tethr-text-3">This CSV is empty.</p>;
  const [header, ...body] = rows;
  const shown = body.slice(0, CSV_MAX_ROWS);
  return (
    <div className={cn("flex w-full min-h-0 flex-1 flex-col gap-2", full ? "px-6 py-6 md:px-10" : "p-4")}>
      <div className="tethr-inset min-h-0 flex-1 overflow-auto">
        <table className="w-max min-w-full border-collapse text-[12px]">
          <thead className="sticky top-0 z-[1] bg-background">
            <tr>
              {header.map((h, i) => (
                <th key={i} className="border-b border-border px-3 py-2 text-left font-mono text-[10px] font-normal uppercase tracking-[0.08em] tethr-text-3">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, ri) => (
              <tr key={ri} className="border-b border-border/50 last:border-0">
                {header.map((_, ci) => {
                  const v = shownCell(r[ci] ?? "");
                  return (
                    <td key={ci} className={cn("max-w-[32ch] truncate px-3 py-1.5", NUMERIC.test(v) && "text-right tabular-nums")} title={v}>
                      {v}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="font-mono text-[10.5px] tethr-text-3">
        {body.length} {body.length === 1 ? "row" : "rows"}
        {body.length > shown.length ? ` · showing the first ${shown.length}; open it in Google Drive or Sheets for the rest` : ""}
      </p>
    </div>
  );
}

function Unpreviewable({ item, text }: { item: FmItem; text: string }) {
  return (
    <div className="flex h-full min-h-[220px] flex-col items-center justify-center gap-3 px-6 text-center">
      <FileGlyph item={item} className="h-14 w-14 text-muted-foreground" />
      <p className="max-w-[36ch] text-[13px] text-muted-foreground">{text}</p>
    </div>
  );
}
