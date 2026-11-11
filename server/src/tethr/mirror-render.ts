import { renderDocument } from "./documents.js";
import type { MirrorFormat, MirrorInput } from "./mirror.js";
import { composeMirrorDoc } from "./mirror.js";

// Non-markdown formats for the shared-folder mirror, rendered by documents.ts
// (the same renderers as the chat's make_document tool). A renderer whose
// library is missing throws, and mirror.ts falls back to markdown (a publish is
// never lost to a renderer).

function metaLine(input: MirrorInput): string {
  const date = (input.publishedAt ?? new Date()).toISOString().slice(0, 10);
  return `${input.agentTag ?? "tethr"} · ${input.kind} · ${date}`;
}

/** Render a published output into the requested format. */
export async function renderMirrorFormat(format: MirrorFormat, input: MirrorInput): Promise<string | Buffer> {
  if (format === "pdf" || format === "pptx" || format === "docx") {
    return renderDocument(format, { title: input.title, markdown: input.body, meta: metaLine(input) });
  }
  return composeMirrorDoc(input);
}
