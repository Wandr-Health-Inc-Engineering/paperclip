import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { columnName, renderDocument, renderWorkbook } from "../tethr/documents.ts";
import { officeText } from "../tethr/office-text.ts";
import { readZip, writeZip } from "../tethr/zip.ts";
import { runTethrTool } from "../tethr/assistant/tethr-tools.ts";
import { classify, decide } from "../tethr/assistant/policy.ts";
import { saveAttachment } from "../tethr/assistant/attachments.ts";
import { rawFsFile, readFsFile } from "../tethr/fsdrive.ts";

// Phase 22: real documents out (PDF, Word, PowerPoint, Excel, HTML) and Office
// files in (their text), all without a shell or a new dependency.

const SAMPLE = [
  "## Where we are",
  "Demand is **up 18%** and *malaria* leads. See [the plan](https://example.com/plan).",
  "",
  "## What to do",
  "1. Refresh the malaria page",
  "2. Pitch two partners",
  "   - travel clinics",
  "",
  "| Channel | Leads |",
  "|---|---|",
  "| Google Ads | 120 |",
  "",
  "> Keep it calm.",
].join("\n");

describe("zip", () => {
  it("round-trips files and refuses what isn't a zip", () => {
    const zip = writeZip([
      { name: "a.txt", data: Buffer.from("hello") },
      { name: "dir/b.xml", data: Buffer.from("<x/>") },
    ]);
    const files = readZip(zip);
    expect([...files.keys()]).toEqual(["a.txt", "dir/b.xml"]);
    expect(files.get("a.txt")!().toString()).toBe("hello");
    expect(() => readZip(Buffer.from("not a zip at all, just text"))).toThrow(/not a zip/);
  });

  it("refuses an entry that unpacks past the limit (a zip bomb)", () => {
    const zip = writeZip([{ name: "big.bin", data: Buffer.alloc(8 * 1024 * 1024) }]);
    expect(zip.length).toBeLessThan(64 * 1024);
    const files = readZip(zip, { entries: 10, entryBytes: 1024 * 1024 });
    expect(() => files.get("big.bin")!()).toThrow(/too large/);
  });
});

describe("Excel workbooks", () => {
  it("writes real sheets: header, numbers as numbers, text never a formula", () => {
    const wb = renderWorkbook([
      { name: "Leads", rows: [["Channel", "Leads", "Note"], ["Google Ads", 120, "=SUM(1,2)"], ["Partners", 35, "a & <b>"]] },
      { name: "Leads", rows: [["x"], [true]] },
      { name: "bad/name:with*chars?and a very long tail beyond", rows: [["y"]] },
    ]);
    const parts = readZip(wb);
    expect([...parts.keys()]).toEqual(
      expect.arrayContaining(["[Content_Types].xml", "xl/workbook.xml", "xl/styles.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet3.xml"]),
    );
    const sheet1 = parts.get("xl/worksheets/sheet1.xml")!().toString();
    expect(sheet1).toContain('<c r="B2"><v>120</v></c>');
    expect(sheet1).toContain('t="inlineStr"><is><t xml:space="preserve">=SUM(1,2)</t>');
    expect(sheet1).toContain("a &amp; &lt;b&gt;");
    const workbook = parts.get("xl/workbook.xml")!().toString();
    expect(workbook).toContain('name="Leads 2"');
    expect(workbook).toMatch(/name="bad name with chars and a very"/);

    const text = officeText("xlsx", wb);
    expect(text).toContain("## Sheet: Leads\nChannel,Leads,Note\nGoogle Ads,120,\"=SUM(1,2)\"\nPartners,35,a & <b>");
    expect(text).toContain("## Sheet: Leads 2\nx\nTRUE");
  });

  it("names columns past Z", () => {
    expect([0, 25, 26, 51, 701, 702].map(columnName)).toEqual(["A", "Z", "AA", "AZ", "ZZ", "AAA"]);
  });
});

describe("Word, PowerPoint and HTML", () => {
  it("builds Word from the Markdown's structure, and reads it back", async () => {
    const docx = await renderDocument("docx", { title: "Spring push", markdown: `${SAMPLE}\n\n<script>alert(1)</script>`, meta: "Wandr" });
    const text = officeText("docx", docx);
    expect(text).toContain("# Spring push");
    expect(text).toContain("## Where we are");
    expect(text).toContain("Demand is up 18% and malaria leads. See the plan (https://example.com/plan).");
    expect(text).toContain("| Channel | Leads |\n| --- | --- |\n| Google Ads | 120 |");
    expect(text).not.toContain("alert");
  });

  it("makes a deck: a title slide, then one slide per ## section", async () => {
    const pptx = await renderDocument("pptx", { title: "Spring push", markdown: SAMPLE });
    const text = officeText("pptx", pptx);
    expect(text).toMatch(/## Slide 1\nSpring push/);
    expect(text).toMatch(/## Slide 2\nWhere we are\nDemand is up 18% and malaria leads\. See the plan\./);
    expect(text).toMatch(/## Slide 3\nWhat to do\nRefresh the malaria page\nPitch two partners\ntravel clinics/);
    expect(text).toContain("\nChannel · Leads\nGoogle Ads · 120\nKeep it calm.");
  });

  it("makes a standalone web page with the title escaped", async () => {
    const html = (await renderDocument("html", { title: "Q1 <plan> & more", markdown: SAMPLE })).toString();
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("<title>Q1 &lt;plan&gt; &amp; more</title>");
    expect(html).toContain("<table>");
  });
});

describe("PDF", () => {
  let server!: http.Server;
  let port = 0;
  const hits: string[] = [];
  let hasChromium = false;

  beforeAll(async () => {
    try {
      const { chromium } = await import("playwright");
      hasChromium = fs.existsSync(chromium.executablePath());
    } catch {
      hasChromium = false;
    }
    server = http.createServer((req, res) => {
      hits.push(req.url ?? "");
      res.end("x");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  it("prints a PDF that can't run scripts or reach the network", async (ctx) => {
    if (!hasChromium) ctx.skip();
    const markdown = `${SAMPLE}\n\n<img src="http://127.0.0.1:${port}/img.png">\n\n<script>fetch("http://127.0.0.1:${port}/script")</script>`;
    const pdf = await renderDocument("pdf", { title: "Spring push", markdown });
    expect(pdf.subarray(0, 4).toString("latin1")).toBe("%PDF");
    expect(hits).toEqual([]);
  }, 60_000);
});

describe("make_document (tethr tools)", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-docs-"));
  const ctx = { workspaceDir: ws, now: () => new Date(2026, 10, 8, 9) };

  it("makes an Excel workbook from rows, never over an existing file", async () => {
    const args = { format: "xlsx", title: "Leads by channel", sheets: [{ name: "Leads", rows: [["Channel", "Leads"], ["Ads", 120]] }] };
    const first = await runTethrTool("make_document", args, ctx);
    const second = await runTethrTool("make_document", args, ctx);
    expect(first.isError).toBeFalsy();
    expect(first.file).toBe("files/Leads by channel.xlsx");
    expect(first.text).toContain("[Saved file: files/Leads by channel.xlsx]");
    expect(second.file).toBe("files/Leads by channel (2).xlsx");
    expect(officeText("xlsx", fs.readFileSync(path.join(ws, first.file!)))).toContain("Ads,120");
  });

  it("makes a workbook from a CSV and a Word document from a Markdown file in files/", async () => {
    fs.writeFileSync(path.join(ws, "files", "ideas.csv"), "keyword,volume\nmalaria pills,4400\n");
    fs.writeFileSync(path.join(ws, "files", "brief.md"), SAMPLE);
    const wb = await runTethrTool("make_document", { format: "excel", title: "Ideas", from_file: "files/ideas.csv" }, ctx);
    expect(officeText("xlsx", fs.readFileSync(path.join(ws, wb.file!)))).toContain("malaria pills,4400");
    const doc = await runTethrTool("make_document", { format: "word", title: "Brief", from_file: "brief.md", save_as: "Spring brief.txt" }, ctx);
    expect(doc.file).toBe("files/Spring brief.docx");
    expect(officeText("docx", fs.readFileSync(path.join(ws, doc.file!)))).toContain("## What to do");
  });

  it("refuses bad input clearly", async () => {
    const outside = await runTethrTool("make_document", { format: "docx", title: "x", from_file: "../CLAUDE.md" }, ctx);
    expect(outside).toMatchObject({ isError: true, text: expect.stringMatching(/from_file must be a file in \.\/files\//) });
    expect((await runTethrTool("make_document", { format: "zip", title: "x", markdown: "y" }, ctx)).text).toMatch(/format must be one of/);
    expect((await runTethrTool("make_document", { format: "pdf", markdown: "y" }, ctx)).text).toMatch(/title/);
    expect((await runTethrTool("make_document", { format: "xlsx", title: "x", from_file: "brief.md" }, ctx)).text).toMatch(/\.csv/);
  });

  it("is allowed like the other tethr tools, and never a shell", () => {
    const c = classify("mcp__tethr__make_document", { format: "pdf", title: "Spring push" }, { workspaceDir: ws, readableRoots: [ws], internalAddresses: [] });
    expect(c).toMatchObject({ cls: "read", summary: "Making a PDF “Spring push”" });
    expect(decide(c, { mode: "read", shell: "off" }).action).toBe("allow");
    expect(decide(c, { mode: "off", shell: "off" }).action).toBe("deny");
  });
});

describe("Office files people attach, and the preview", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-office-"));
  const now = new Date(2026, 10, 8, 9);

  it("saves a Word attachment with a text copy beside it", async () => {
    const docx = await renderDocument("docx", { title: "Partner plan", markdown: SAMPLE });
    const saved = await saveAttachment(ws, "Partner plan.docx", docx, now);
    expect(saved).toMatchObject({ path: "files/uploads/2026-11-08/Partner plan.docx", kind: "office" });
    const copy = fs.readFileSync(path.join(ws, "files/uploads/2026-11-08/Partner plan.docx.md"), "utf8");
    expect(copy).toContain("# Partner plan");
    expect(copy).toContain("Google Ads | 120");
  });

  it("refuses an Office file it can't read", async () => {
    const saved = await saveAttachment(ws, "broken.xlsx", Buffer.from("not really a workbook"), now);
    expect(saved).toMatchObject({ error: expect.stringMatching(/couldn't read broken\.xlsx/) });
    expect(fs.existsSync(path.join(ws, "files/uploads/2026-11-08/broken.xlsx"))).toBe(false);
  });

  it("previews Office files as text and serves only PDFs and images raw", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-preview-"));
    fs.writeFileSync(path.join(root, "deck.pptx"), await renderDocument("pptx", { title: "Deck", markdown: SAMPLE }));
    fs.writeFileSync(path.join(root, "doc.pdf"), "%PDF-1.4 test");
    fs.writeFileSync(path.join(root, "page.html"), "<script>x</script>");
    fs.writeFileSync(path.join(root, "logo.svg"), "<svg/>");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-outside-"));
    fs.writeFileSync(path.join(outside, "secret.png"), "png");
    fs.symlinkSync(path.join(outside, "secret.png"), path.join(root, "linked.png"));

    expect(await readFsFile(root, "deck.pptx")).toMatchObject({ kind: "office", content: expect.stringContaining("## Slide 2") });
    expect(await rawFsFile(root, "doc.pdf")).toMatchObject({ type: "application/pdf" });
    expect(await rawFsFile(root, "page.html")).toBeNull();
    expect(await rawFsFile(root, "logo.svg")).toBeNull();
    expect(await rawFsFile(root, "../" + path.basename(outside) + "/secret.png")).toBeNull();
    expect(await rawFsFile(root, "linked.png")).toBeNull();
  });
});

// Guard against an accidental zlib API change breaking the writer.
it("node has zlib.crc32", () => {
  expect(typeof zlib.crc32).toBe("function");
});
