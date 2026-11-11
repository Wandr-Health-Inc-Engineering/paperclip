// Published-content memory (Phase 6). Prevents the founding-doc failure mode —
// an agent re-suggesting an already-published article/brief/itinerary. Records
// live in `tethr_memories` (company-scoped, kind "published-content") with the
// fingerprint carried inside the content string, since the table has no
// dedicated key column. The routing engine consults this before content tasks
// and attaches an advisory warning (never a hard block).
//
// This complements the tracker-based publish log in state.ts (which powers the
// content calendars); here the *memory* layer gains real dedup so recall works.

import type { Db } from "@paperclipai/db";
import { memoryService } from "./memory.js";

export type PublishedKind = "blog" | "brief" | "itinerary" | "content";

export interface PublishedItem {
  kind: PublishedKind;
  slug: string;
  title: string;
  /** ISO date if known. */
  date?: string;
}

const MARK = "published-content";
/** e.g. `published-content:blog:peru-altitude-guide` */
export function publishedFingerprint(kind: PublishedKind, slug: string): string {
  return `${MARK}:${kind}:${slug}`;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
}

/** Encode a published item as a memory content string (fingerprint + metadata). */
export function encodePublished(item: PublishedItem): string {
  const date = item.date ? ` (published ${item.date})` : "";
  return `[${publishedFingerprint(item.kind, item.slug)}] ${item.title}${date}`;
}

const DECODE_RE = new RegExp(`\\[${MARK}:([a-z]+):([^\\]\\s]+)\\]\\s*(.*?)(?:\\s*\\(published ([^)]+)\\))?$`);

export function decodePublished(content: string): PublishedItem | null {
  const m = DECODE_RE.exec(content.trim());
  if (!m) return null;
  return { kind: m[1] as PublishedKind, slug: m[2], title: (m[3] ?? "").trim(), date: m[4] };
}

// ---- Corpus parsing (blueprint memory-published-articles.md) --------------

const KIND_HINTS: Array<[RegExp, PublishedKind]> = [
  [/itinerar/i, "itinerary"],
  [/brief/i, "brief"],
  [/blog|article|post/i, "blog"],
];

/** Heuristic parse of a markdown-ish corpus: one published item per list line. */
export function parsePublishedCorpus(text: string, defaultKind: PublishedKind = "content"): PublishedItem[] {
  const items: PublishedItem[] = [];
  let sectionKind: PublishedKind | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      sectionKind = KIND_HINTS.find(([re]) => re.test(line))?.[1] ?? null;
      continue;
    }
    const listMatch = /^[-*+]\s+(.*)$/.exec(line);
    if (!listMatch) continue;
    let rest = listMatch[1];
    // strip a leading markdown link -> keep its text
    rest = rest.replace(/^\[([^\]]+)\]\([^)]*\)/, "$1");
    const date = /(\d{4}-\d{2}-\d{2})/.exec(rest)?.[1];
    // title = text before a pipe/em-dash/paren-date, cleaned
    const title = rest
      .split(/\s+[|–—]\s+/)[0]
      .replace(/\(?\bpublished\b[^)]*\)?/i, "")
      .replace(/\(\d{4}-\d{2}-\d{2}\)/, "")
      .replace(/[*_`]/g, "")
      .trim();
    if (!title) continue;
    const kind = sectionKind ?? KIND_HINTS.find(([re]) => re.test(rest))?.[1] ?? defaultKind;
    items.push({ kind, slug: slugify(title), title, date });
  }
  return items;
}

// ---- Duplicate matching ---------------------------------------------------

/** Does a proposed topic match a published item? Slug overlap or strong title overlap. */
export function isDuplicateTopic(topic: string, item: PublishedItem): boolean {
  const t = topic.toLowerCase();
  const tSlug = slugify(topic);
  if (item.slug && (tSlug.includes(item.slug) || item.slug.includes(tSlug))) return true;
  // significant word overlap against the title (ignore short/stopwords)
  const titleWords = new Set(
    item.title.toLowerCase().split(/\W+/).filter((w) => w.length >= 4),
  );
  if (titleWords.size === 0) return false;
  const topicWords = t.split(/\W+/).filter((w) => w.length >= 4);
  const overlap = topicWords.filter((w) => titleWords.has(w)).length;
  return overlap >= Math.min(2, titleWords.size);
}

export function findPublishedDuplicate(topic: string, items: PublishedItem[]): PublishedItem | null {
  return items.find((i) => isDuplicateTopic(topic, i)) ?? null;
}

// ---- DB helpers -----------------------------------------------------------

/** Idempotent record: skips if the same fingerprint already exists. */
export async function recordPublished(db: Db, companyId: string, item: PublishedItem, agentId?: string | null): Promise<"created" | "exists"> {
  const memory = memoryService(db);
  const fp = publishedFingerprint(item.kind, item.slug);
  const existing = await memory.recall(companyId, agentId ?? null, fp, 5);
  if (existing.some((r) => (r.content ?? "").includes(fp))) return "exists";
  await memory.record({ companyId, agentId: agentId ?? null, kind: "published-content", content: encodePublished(item), source: item.slug });
  return "created";
}

/** Load all published-content memories for a company. */
export async function listPublished(db: Db, companyId: string): Promise<PublishedItem[]> {
  const rows = await memoryService(db).recall(companyId, null, MARK, 500);
  const items: PublishedItem[] = [];
  for (const r of rows) {
    const item = decodePublished(r.content ?? "");
    if (item) items.push(item);
  }
  return items;
}

/** Recall + match a proposed topic; returns an advisory warning or null. */
export async function publishedDuplicateWarning(db: Db, companyId: string, topic: string): Promise<string | null> {
  const items = await listPublished(db, companyId);
  const dup = findPublishedDuplicate(topic, items);
  if (!dup) return null;
  const when = dup.date ? ` (published ${dup.date})` : "";
  return `Possible duplicate of already-published ${dup.kind} "${dup.title}"${when}. Confirm this is a refresh, not a repeat, before creating new content.`;
}

/** Heuristic: is this request a content-creation task worth a dedup check? */
export function isContentRequest(text: string): boolean {
  return /\b(blog|article|post|write|brief|itinerary|guide|content)\b/i.test(text);
}
