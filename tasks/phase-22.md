# Phase 22: tethr as an operational harness (documents in and out, a working animation)

Mark's notes (2026-11-08, before end-to-end testing):
- "When I submit in chat I want the system to have a cool animation thing like Claude does when it's
  processing, like a little nebula, an endless loop until it's done, so I know."
- "I need more than just .md capacity. We need PDF and all those skills and capacities too. This
  system is more like an operational harness."

## What exists
- The chat's Claude session already loads Mark's own skills (`~/.claude/skills`, 76 of them) and is
  allowed the Skill tool. Instruction-only skills (copywriting, SEO…) work today.
- Anthropic's document skills (pdf, docx, pptx, xlsx) need Python through the shell, and the chat's
  shell is off by design (a shell on Mark's Mac is the one thing the gate can't make safe).
- The server already renders Markdown to PDF (Playwright Chromium), Word (docx) and PowerPoint
  (pptxgenjs) for the Drive mirror (`mirror-render.ts`). Nothing exposes them to the chat.
- The side panel and Drive preview text only; PDFs, images and Office files say "No preview".
- Attachments refuse Word, Excel and PowerPoint.
- While a reply runs, the chat shows two small cogs with "thinking…" until the first words arrive,
  then only a tiny dot.

## 22.1 The working animation
- `Nebula` (ui/src/components/tethr/Nebula.tsx + `.tethr-nebula*` in tethr-theme.css): a small
  monochrome nebula, soft drifting clouds around a bright core with motes orbiting, looping until
  the turn ends. CSS only, `currentColor`, works in Day and Night; reduced motion shows it still.
- Shown for the whole time a turn runs, not only before the first words: one status row at the
  end of the turn, `[nebula] thinking · 12s · Stop`. The label says what's happening: waiting for
  the previous message, thinking, the tool step in progress, writing.

## 22.2 Documents out: `make_document` (Tethr tools)
- One tool on the chat's `tethr` MCP server, run in the tethr server (no shell):
  - `format`: pdf | docx | pptx | xlsx | html
  - `title`, `save_as` (name in files/), and the content: `markdown` (or `from_file`, a .md/.txt in
    files/) for pdf/docx/pptx/html; `sheets` [{name, rows}] (or `from_file`, a CSV) for xlsx.
  - Saved with `writeNewFile` (never overwrites), the result ends with `[Saved file: files/…]`, so the
    chip and side panel work as they do for CSVs.
- Renderers move to `server/src/tethr/documents.ts` (the mirror keeps using them):
  - PDF: Markdown → HTML → Chromium print, with JavaScript off and every network request blocked
    (a document can't fetch or leak anything).
  - Word: built from Markdown tokens (headings, paragraphs with bold/italic/code, lists, tables,
    quotes, code blocks), not line-by-line.
  - PowerPoint: a title slide plus one slide per `##` section.
  - Excel: a small writer (`xlsx.ts`, no new dependency) for one or more sheets, bold header row.
- Gate: class `read` like `score_list` (it only writes into tethr's own files/ folder).

## 22.3 Seeing documents
- PDFs and images preview in the side panel and the Drive (a raw-file route that serves only
  pdf/png/jpg/gif/webp, `nosniff`, root-confined, people only).
- Word, PowerPoint and Excel show a card with **Show in Finder** (`open -R`, which only reveals and
  never runs anything), so they open in the right app.

## 22.4 Documents in: reading Office attachments
- Word, Excel and PowerPoint attachments are accepted. The original is kept, and a text copy is
  written next to it (docx → paragraphs, xlsx → one CSV block per sheet, pptx → text per slide), so
  Claude's Read tool can use it. A small zip reader (`office.ts`) does it, no new dependency.

## Tests
- `tethr-documents.test.ts`: each format renders (PDF magic bytes; docx/pptx/xlsx are zips with
  the right parts), the xlsx round-trips through the reader, the PDF renderer blocks network.
- `make_document` through the tools endpoint: saves into files/, never overwrites, refuses paths
  outside files/.
- Attachments: Office files are accepted and get a text copy.
- Raw route: only the allowed types, never outside the root.
- UI: typecheck and the existing suites; verify the animation and previews in the browser.
