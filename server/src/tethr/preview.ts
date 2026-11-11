// Content preview for completion/confirmation messages: lets a human
// sanity-check what an agent produced without opening the Drive. Pure text
// helpers — safe to import from worker.ts and slack.ts alike (no deps).

const MAX_LINES = 3;
const MAX_CHARS = 280;
const MAX_LINE_CHARS = 120;

export interface ContentPreview {
  /** The opening lines, "> "-quoted (valid in both GFM and Slack mrkdwn). */
  snippet: string;
  wordCount: number;
}

/**
 * Title + first lines + word count from a deliverable body. Returns null for
 * bodies too short to be worth previewing (the title already says it all).
 */
export function contentPreview(body: string): ContentPreview | null {
  const text = String(body ?? "").trim();
  if (!text) return null;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount < 20) return null;

  const lines: string[] = [];
  let used = 0;
  for (const raw of text.split(/\r?\n/)) {
    // Skip blanks, horizontal rules, and front-matter fences — keep prose.
    const line = raw.replace(/^#{1,6}\s+/, "").replace(/^[-*]\s+/, "").trim();
    if (!line || /^(-{3,}|\*{3,}|={3,})$/.test(line)) continue;
    const clipped = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line;
    if (used + clipped.length > MAX_CHARS && lines.length > 0) break;
    lines.push(clipped);
    used += clipped.length;
    if (lines.length >= MAX_LINES) break;
  }
  if (!lines.length) return null;
  return { snippet: lines.map((l) => `> ${l}`).join("\n"), wordCount };
}

/** "~1,860 words" — compact, locale-formatted. */
export function wordCountLabel(wordCount: number): string {
  return `~${wordCount.toLocaleString("en-US")} words`;
}
