import type { MirrorFormat, MirrorInput } from "./mirror.js";
import { composeMirrorDoc } from "./mirror.js";

// Non-markdown renderers for the shared-folder mirror. Every library is loaded
// with a dynamic import so a missing dependency degrades to the markdown
// fallback in mirror.ts (a publish is never lost to a renderer). Installs:
//   PDF  → pnpm --filter @paperclipai/server add marked playwright
//   PPTX → pnpm --filter @paperclipai/server add pptxgenjs
//   DOCX → pnpm --filter @paperclipai/server add docx

// Brand-locked print styling: Urbanist/JetBrains Mono, pure black on white,
// 2px rules — the Tethr wireframe aesthetic on paper.
function htmlShell(title: string, bodyHtml: string, meta: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { margin: 22mm 18mm; }
  body { font-family: Urbanist, -apple-system, Helvetica, Arial, sans-serif; color: #000; font-size: 11.5pt; line-height: 1.55; }
  h1 { font-size: 22pt; border-bottom: 2px solid #000; padding-bottom: 6pt; margin: 0 0 4pt; }
  h2 { font-size: 14pt; margin-top: 18pt; }
  h3 { font-size: 12pt; }
  .meta { font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 8.5pt; color: #444; margin-bottom: 18pt; }
  table { border-collapse: collapse; width: 100%; margin: 10pt 0; }
  th, td { border: 1px solid #000; padding: 4pt 6pt; text-align: left; font-size: 10pt; }
  code, pre { font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 9.5pt; background: #f2f2f2; }
  pre { padding: 8pt; overflow-x: hidden; white-space: pre-wrap; }
  blockquote { border-left: 2px solid #000; margin-left: 0; padding-left: 10pt; color: #333; }
  a { color: #000; }
  </style></head><body><h1>${escapeHtml(title)}</h1><div class="meta">${escapeHtml(meta)}</div>${bodyHtml}</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function metaLine(input: MirrorInput): string {
  const date = (input.publishedAt ?? new Date()).toISOString().slice(0, 10);
  return `${input.agentTag ?? "tethr"} · ${input.kind} · ${date}`;
}

async function renderPdf(input: MirrorInput): Promise<Buffer> {
  const { marked } = await import("marked");
  const { chromium } = await import("playwright");
  const bodyHtml = await marked.parse(input.body, { async: true });
  const html = htmlShell(input.title, bodyHtml, metaLine(input));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const pdf = await page.pdf({ format: "Letter", printBackground: true });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

/** Slides split on `##` headings; the title heads the deck. Body lines become
 * bullets (markdown emphasis stripped — PPTX text is plain). */
async function renderPptx(input: MirrorInput): Promise<Buffer> {
  const mod = (await import("pptxgenjs")) as unknown as {
    default: new () => import("pptxgenjs").default;
  };
  const PptxGenJS = mod.default;
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "WIDE", width: 13.33, height: 7.5 });
  pptx.layout = "WIDE";

  const strip = (s: string) =>
    s.replace(/\*\*|__|\*|_|`/g, "").replace(/^#+\s*/, "").replace(/^[-*+]\s+/, "").trim();

  const title = pptx.addSlide();
  title.background = { color: "FFFFFF" };
  title.addText(input.title, {
    x: 0.6, y: 2.6, w: 12.1, h: 1.6, fontFace: "Urbanist", fontSize: 40, bold: true, color: "000000",
  });
  title.addText(metaLine(input), {
    x: 0.6, y: 4.3, w: 12.1, h: 0.5, fontFace: "JetBrains Mono", fontSize: 12, color: "444444",
  });

  const sections = input.body.split(/\n(?=##\s)/);
  for (const section of sections) {
    const lines = section.split("\n").filter((l) => l.trim());
    if (!lines.length) continue;
    const heading = lines[0].startsWith("##") ? strip(lines[0]) : "Overview";
    const bullets = (lines[0].startsWith("##") ? lines.slice(1) : lines)
      .map(strip)
      .filter(Boolean)
      .slice(0, 10);
    if (!bullets.length) continue;
    const slide = pptx.addSlide();
    slide.background = { color: "FFFFFF" };
    slide.addText(heading, {
      x: 0.6, y: 0.4, w: 12.1, h: 0.9, fontFace: "Urbanist", fontSize: 28, bold: true, color: "000000",
    });
    slide.addText(
      bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })),
      { x: 0.6, y: 1.6, w: 12.1, h: 5.4, fontFace: "Urbanist", fontSize: 16, color: "000000", valign: "top" },
    );
  }
  const out = await pptx.write({ outputType: "nodebuffer" });
  return out as Buffer;
}

async function renderDocx(input: MirrorInput): Promise<Buffer> {
  const docx = await import("docx");
  const { Document, Packer, Paragraph, HeadingLevel, TextRun } = docx;
  const children = [
    new Paragraph({ text: input.title, heading: HeadingLevel.TITLE }),
    new Paragraph({ children: [new TextRun({ text: metaLine(input), font: "JetBrains Mono", size: 16, color: "444444" })] }),
    new Paragraph({ text: "" }),
  ];
  for (const raw of input.body.split("\n")) {
    const line = raw.trimEnd();
    if (/^###\s/.test(line)) children.push(new Paragraph({ text: line.replace(/^###\s*/, ""), heading: HeadingLevel.HEADING_3 }));
    else if (/^##\s/.test(line)) children.push(new Paragraph({ text: line.replace(/^##\s*/, ""), heading: HeadingLevel.HEADING_2 }));
    else if (/^#\s/.test(line)) children.push(new Paragraph({ text: line.replace(/^#\s*/, ""), heading: HeadingLevel.HEADING_1 }));
    else if (/^[-*+]\s+/.test(line)) children.push(new Paragraph({ text: line.replace(/^[-*+]\s+/, "").replace(/\*\*|__|`/g, ""), bullet: { level: 0 } }));
    else children.push(new Paragraph({ text: line.replace(/\*\*|__|`/g, "") }));
  }
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

/** Render a published output into the requested format. Throws when the format's
 * library is missing — the caller (mirror.ts) falls back to markdown. */
export async function renderMirrorFormat(format: MirrorFormat, input: MirrorInput): Promise<string | Buffer> {
  switch (format) {
    case "pdf":
      return renderPdf(input);
    case "pptx":
      return renderPptx(input);
    case "docx":
      return renderDocx(input);
    default:
      return composeMirrorDoc(input);
  }
}
