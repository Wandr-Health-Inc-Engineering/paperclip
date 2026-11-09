// Smooth streaming for chat answers (Mark, 2026-11-08: "the text is coming
// out in clunks"). The server writes the answer every ~250ms and the chat polls
// every 500ms, so text lands in bursts. The chat reveals it word by word at a
// pace that trails the stream slightly, and each new word fades in. These are
// the pure parts: how fast to reveal, where the next word ends, and how to keep
// half-written Markdown from flashing raw symbols.

/** Never reveal slower than this (characters per second), so the tail finishes. */
export const MIN_CHARS_PER_SECOND = 40;
/** While the answer is still streaming, trail it by about this much. */
export const STREAM_LAG_SECONDS = 0.7;
/** Once the turn is done, catch up with what's left a little faster. */
export const FINISH_LAG_SECONDS = 0.35;
/** How quickly the reveal speed itself follows the backlog (seconds). */
export const RATE_SMOOTHING_SECONDS = 0.3;

/** The reveal speed for a backlog of `backlog` characters. */
export function targetRate(backlog: number, live: boolean): number {
  const lag = live ? STREAM_LAG_SECONDS : FINISH_LAG_SECONDS;
  return Math.max(MIN_CHARS_PER_SECOND, backlog / lag);
}

/** Ease the current speed toward the target over `dt` seconds. */
export function smoothRate(current: number, target: number, dt: number): number {
  const blend = 1 - Math.exp(-dt / RATE_SMOOTHING_SECONDS);
  return current + (target - current) * blend;
}

// A token made only of Markdown structure ("-", "1.", "##", ">", "|") waits for
// the word after it, so a list item or heading never shows as a bare marker.
const MARKER_ONLY = /^(?:[-*+>#|]+|\d+[.)])$/;

/**
 * Where to cut `text` so that at least `cursor` characters show and the cut
 * falls at the end of a word. While the answer is still streaming, the last
 * word may be incomplete, so the cut never goes past the last whitespace;
 * once it's done, the whole text can show.
 */
export function revealEnd(text: string, cursor: number, live: boolean): number {
  const limit = live ? lastWordBoundary(text) : text.length;
  let end = Math.min(Math.max(0, Math.floor(cursor)), limit);
  // Mid-word: finish the word.
  if (end > 0 && !/\s/.test(text[end] ?? " ") && !/\s/.test(text[end - 1])) end = nextWordEnd(text, end, limit);
  // A bare marker waits for the word after it.
  while (end < limit && MARKER_ONLY.test(lastToken(text, end))) end = nextWordEnd(text, end, limit);
  return end;
}

function lastWordBoundary(text: string): number {
  for (let i = text.length - 1; i >= 0; i--) {
    if (/\s/.test(text[i])) return i;
  }
  return 0;
}

/** The index just after the word that contains or follows `from`. */
function nextWordEnd(text: string, from: number, limit: number): number {
  let i = from;
  while (i < limit && /\s/.test(text[i])) i++;
  while (i < limit && !/\s/.test(text[i])) i++;
  return i;
}

function lastToken(text: string, end: number): string {
  let start = end;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  return text.slice(start, end);
}

/**
 * Close Markdown that's open at the cut, so a half-written answer renders the
 * way it will look: an open code fence, inline code or bold gets its closing
 * mark (only the last block is checked for inline marks).
 */
export function closeOpenMarkdown(md: string): string {
  const fences = md.match(/^ {0,3}(```|~~~)/gm)?.length ?? 0;
  if (fences % 2 === 1) return `${md}\n\`\`\``;
  const lastBlock = md.slice(md.lastIndexOf("\n\n") + 1);
  if ((lastBlock.match(/`/g)?.length ?? 0) % 2 === 1) return `${md}\``;
  if ((lastBlock.match(/\*\*/g)?.length ?? 0) % 2 === 1) return `${md}**`;
  return md;
}

// ---- the fade: wrap each new word in a span the CSS animates ---------------

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

export const STREAM_WORD_CLASS = "tethr-w";

/**
 * A rehype plugin: every word becomes `<span class="tethr-w">` (code blocks and
 * inline code are faded whole). react-markdown keys elements by their position
 * among siblings, so words already on screen keep their elements and only the
 * new ones mount, and so only they play the fade.
 */
export function rehypeStreamWords() {
  return (tree: unknown) => wrapWords(tree as HastNode);
}

function wrapWords(node: HastNode): void {
  if (!node.children) return;
  const next: HastNode[] = [];
  for (const child of node.children) {
    if (child.type === "text") {
      next.push(...splitWords(child.value ?? ""));
    } else if (child.type === "element" && (child.tagName === "pre" || child.tagName === "code")) {
      next.push(withClass(child, STREAM_WORD_CLASS));
    } else {
      wrapWords(child);
      next.push(child);
    }
  }
  node.children = next;
}

function splitWords(value: string): HastNode[] {
  return value
    .split(/(\s+)/)
    .filter(Boolean)
    .map((part) =>
      /^\s+$/.test(part)
        ? { type: "text", value: part }
        : { type: "element", tagName: "span", properties: { className: [STREAM_WORD_CLASS] }, children: [{ type: "text", value: part }] },
    );
}

function withClass(node: HastNode, name: string): HastNode {
  const current = node.properties?.className;
  const list = Array.isArray(current) ? current : typeof current === "string" ? [current] : [];
  return { ...node, properties: { ...node.properties, className: [...list, name] } };
}
