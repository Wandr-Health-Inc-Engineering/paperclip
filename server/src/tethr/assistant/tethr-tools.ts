import fsp from "node:fs/promises";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { writeNewFile } from "../atomic.js";
import { GoalInputError, goalsContextText, goalsService, METRIC_SOURCES, METRIC_UNITS } from "../goals.js";
import { JevError, jevAsk, jevConfigured, jevCostUsd, type JevAnswer, type JevCallOptions, type JevQuestion } from "../jev.js";
import { googleAdsConfigured } from "../tools/google-ads.js";
import { generateKeywordIdeas, KeywordPlannerAccessError, type KeywordIdea } from "../tools/keyword-planner.js";
import { FILES_DIR } from "./workspace.js";

// Tethr's own tools for the chat (phase 19), served to its Claude session as the
// MCP server "tethr" (see tools-bridge.ts). The work runs HERE, in the Tethr
// server, so API keys (TypeSafe, Google Ads) never reach the Claude process.
// - score_list: rate a long list (keywords, leads, posts) with Jev, one request
//   per item, all criteria answered in parallel; composite 0–100; CSV of all rows.
// - keyword_ideas: Google Keyword Planner volumes for seed phrases; CSV of all
//   ideas, so score_list can read them without the list going back through Claude.
// Both are read-only: they change nothing outside Tethr's workspace files/.

export const TETHR_TOOLS_SERVER = "tethr";
export const TETHR_TOOLS_LABEL = "Tethr tools";

export const SCORE_LIMITS = {
  items: 500,
  criteria: 8,
  itemChars: 4_000,
  contextChars: 4_000,
  fileBytes: 2_000_000,
  top: 25,
  concurrency: 8,
};

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface TethrToolResult {
  text: string;
  isError?: boolean;
  /** A file the tool wrote, relative to the workspace ("files/x.csv"). */
  file?: string;
  /** For the activity log (counts and timings, never content). */
  meta?: Record<string, unknown>;
}

/** The line a tool result ends with when it saved a file: the chat shows that
 * file as a chip (events.ts reads it from the result, so a failed call or an
 * auto-saved file is shown as it really is). */
export const SAVED_FILE_RE = /^\[Saved file: (files\/[^\]\n]+)\]$/m;
export const savedFileLine = (rel: string) => `[Saved file: ${rel}]`;

/** Write a CSV into files/ under a NEW name (never over an existing file, such
 * as the list being scored); returns its workspace-relative path. */
async function saveCsv(ctx: TethrToolContext, name: string, rows: Array<Array<string | number | null | undefined>>): Promise<string> {
  const used = await writeNewFile(filesDir(ctx), name, toCsv(rows));
  return `${FILES_DIR}/${used}`;
}

export interface TethrToolContext {
  workspaceDir: string;
  /** For the goal tools (phase 20). */
  db?: Db;
  companyId?: string;
  now?: () => Date;
  jev?: JevCallOptions;
  concurrency?: number;
  keywordIdeas?: (seeds: string[], geo?: string[]) => Promise<KeywordIdea[]>;
}

export const TETHR_TOOL_DEFS: McpToolDef[] = [
  {
    name: "score_list",
    description:
      "Score and rank a long list (keywords, leads, companies, Reddit posts, ideas) with Jev, a fast decision model: it rates every item against your criteria in seconds for a fraction of a cent. Use it instead of judging more than ~15 items yourself. Give `items` (strings or objects) or `from_file` (a CSV, JSON or one-per-line file in ./files/, e.g. one keyword_ideas saved). Each criterion is ONE narrow question: type \"score\" with `levels` ordered worst to best, \"yes_no\" (set want:\"no\" when a yes is bad), or \"choice\" with `options`. Weights combine score and yes_no criteria into a 0-100 composite. Put shared background (what the company sells, who it's for) in `context`. Returns the top rows; pass `save_as` to keep every row as a CSV in ./files/.",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", items: {}, maxItems: SCORE_LIMITS.items, description: "The list to score: strings or objects (max 500)." },
        from_file: { type: "string", description: "Read the list from a file in ./files/ instead: CSV with a header row, a JSON array, or one item per line." },
        criteria: {
          type: "array",
          minItems: 1,
          maxItems: SCORE_LIMITS.criteria,
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Short column name, e.g. catalog_fit." },
              question: { type: "string", description: "One narrow question about a single item." },
              type: { type: "string", enum: ["score", "yes_no", "choice"] },
              levels: { type: "array", items: { type: "string" }, description: "score: 2-10 levels, worst first, each describing when it applies." },
              options: { type: "object", additionalProperties: { type: "string" }, description: "choice: option name -> when it applies." },
              want: { type: "string", enum: ["yes", "no"], description: "yes_no: which answer is better (default yes)." },
              weight: { type: "number", minimum: 0, maximum: 10, description: "Weight in the composite (default 1; 0 = show only)." },
            },
            required: ["question", "type"],
          },
        },
        context: { type: "string", description: "Background every item is judged against (max 4,000 characters)." },
        top: { type: "integer", minimum: 1, maximum: 100, description: "How many top rows to return (default 25)." },
        save_as: { type: "string", description: "CSV file name in ./files/ for every row." },
      },
      required: ["criteria"],
    },
  },
  {
    name: "keyword_ideas",
    description:
      "Real Google search volume, competition and cost per click for keyword ideas from up to 20 seed phrases (Google Keyword Planner; US by default). Read-only. Pass `save_as` to keep every idea as a CSV in ./files/, then rank them with score_list using from_file.",
    inputSchema: {
      type: "object",
      properties: {
        seeds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20, description: "Seed keywords or phrases." },
        geo_target_ids: { type: "array", items: { type: "string" }, description: "Google geo target ids (default [\"2840\"] = United States)." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "How many ideas to return, by volume (default 50)." },
        save_as: { type: "string", description: "CSV file name in ./files/ for every idea." },
      },
      required: ["seeds"],
    },
  },
  {
    name: "goals_list",
    description:
      "The company's goals as stored in Tethr: each goal with its id, and each metric with its id, baseline, current value, target and date, and how it's measured.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "save_goal",
    description:
      "Create or update one of the company's goals in Tethr: a goal area such as New customers. Pass id to update. Only save what the person you're working with agreed to.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Existing goal id, to update it." },
        title: { type: "string", description: "Short title, e.g. \"New customers\"." },
        description: { type: "string", description: "What this goal means and why it matters, in a sentence or two." },
        status: { type: "string", enum: ["planned", "active", "achieved", "cancelled"] },
      },
    },
  },
  {
    name: "save_metric",
    description:
      "Create or update the metric that measures a goal: name, unit, baseline, target and target date, and EXACTLY how to measure it (source + method, e.g. \"Stripe: count of first successful charges per new customer in the last 30 days\"). Pass id to update. Numbers only, aggregates only: never a customer's name, email or health details. Only save targets the person you're working with agreed to.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Existing metric id, to update it." },
        goal_id: { type: "string", description: "The goal it measures (from goals_list or save_goal)." },
        name: { type: "string", description: "e.g. \"New paying customers per month\"." },
        unit: { type: "string", enum: [...METRIC_UNITS] },
        direction: { type: "string", enum: ["up", "down"], description: "up = higher is better (default)." },
        source: { type: "string", enum: [...METRIC_SOURCES] },
        method: { type: "string", description: "How to measure it the same way every time: the tool, report or query, the time window, filters." },
        baseline: { type: "number" },
        baseline_at: { type: "string", description: "YYYY-MM-DD the baseline was measured." },
        target: { type: "number" },
        target_date: { type: "string", description: "YYYY-MM-DD." },
      },
    },
  },
  {
    name: "record_metric",
    description:
      "Record a new measurement for a metric (it becomes the current value and joins its history). Measure it exactly the way its method says. One aggregate number only.",
    inputSchema: {
      type: "object",
      properties: {
        metric_id: { type: "string" },
        value: { type: "number" },
        at: { type: "string", description: "YYYY-MM-DD the value is for (default today)." },
        note: { type: "string", description: "Short note, e.g. the window measured." },
      },
      required: ["metric_id", "value"],
    },
  },
];

// ---- criteria --------------------------------------------------------------

export interface Criterion {
  key: string;
  question: string;
  type: "score" | "yes_no" | "choice";
  levels: string[];
  options: Record<string, string | null>;
  want: "yes" | "no";
  weight: number;
}

const DEFAULT_LEVELS = ["Not at all", "Slightly", "Moderately", "Very", "Completely"];

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Validate the criteria. Returns them, or a plain-language error. */
export function parseCriteria(raw: unknown): Criterion[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return "Give at least one criterion.";
  if (raw.length > SCORE_LIMITS.criteria) return `Use at most ${SCORE_LIMITS.criteria} criteria.`;
  const out: Criterion[] = [];
  const used = new Set<string>();
  for (const [i, entry] of raw.entries()) {
    if (!entry || typeof entry !== "object") return `Criterion ${i + 1} isn't an object.`;
    const c = entry as Record<string, unknown>;
    const question = str(c.question, 1_000);
    if (!question) return `Criterion ${i + 1} needs a question.`;
    const type = c.type === "score" || c.type === "yes_no" || c.type === "choice" ? c.type : null;
    if (!type) return `Criterion ${i + 1}: type must be score, yes_no or choice.`;
    let key = slug(str(c.name, 80)) || slug(question) || `c${i + 1}`;
    for (let n = 2; used.has(key); n++) key = `${key.replace(/_\d+$/, "")}_${n}`;
    used.add(key);

    let levels: string[] = [];
    if (type === "score") {
      levels = Array.isArray(c.levels) ? c.levels.map((l) => str(l, 300)).filter(Boolean) : [];
      if (!levels.length) levels = DEFAULT_LEVELS;
      if (levels.length < 2 || levels.length > 10) return `Criterion ${i + 1}: give 2 to 10 levels, worst first.`;
    }
    const options: Record<string, string | null> = {};
    if (type === "choice") {
      if (Array.isArray(c.options)) {
        for (const o of c.options) {
          const name = str(o, 100);
          if (name) options[name] = null;
        }
      } else if (c.options && typeof c.options === "object") {
        for (const [k, v] of Object.entries(c.options as Record<string, unknown>)) {
          if (k.trim()) options[k.trim().slice(0, 100)] = str(v, 300) || null;
        }
      }
      const n = Object.keys(options).length;
      if (n < 2 || n > 50) return `Criterion ${i + 1}: give 2 to 50 options.`;
    }
    const weightRaw = typeof c.weight === "number" && Number.isFinite(c.weight) ? c.weight : 1;
    out.push({
      key,
      question,
      type,
      levels,
      options,
      want: c.want === "no" ? "no" : "yes",
      weight: type === "choice" ? 0 : Math.max(0, Math.min(10, weightRaw)),
    });
  }
  return out;
}

export function jevQuestions(criteria: Criterion[]): Record<string, JevQuestion> {
  const q: Record<string, JevQuestion> = {};
  for (const c of criteria) {
    if (c.type === "yes_no") q[c.key] = { type: "noul", instructions: c.question };
    else if (c.type === "score") q[c.key] = { type: "score", instructions: c.question, criteria: c.levels };
    else q[c.key] = { type: "choice", instructions: c.question, criteria: c.options };
  }
  return q;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** One answer as 0..1, higher = better (score and yes_no only). */
export function normalized(c: Criterion, a: JevAnswer | undefined): number | null {
  if (!a) return null;
  if (c.type === "score" && a.type === "score") return clamp01(a.score / Math.max(1, c.levels.length - 1));
  if (c.type === "yes_no" && a.type === "noul") return clamp01(c.want === "no" ? 1 - a.noul : a.noul);
  return null;
}

/** Weighted mean of the normalized answers, 0..1, or null when nothing is weighted. */
export function compositeOf(criteria: Criterion[], answers: Record<string, JevAnswer>): number | null {
  let sum = 0;
  let weight = 0;
  for (const c of criteria) {
    if (c.weight <= 0) continue;
    const v = normalized(c, answers[c.key]);
    if (v === null) continue;
    sum += c.weight * v;
    weight += c.weight;
  }
  return weight > 0 ? sum / weight : null;
}

/** Criteria Jev wasn't sure about for this item. */
export function uncertainOf(criteria: Criterion[], answers: Record<string, JevAnswer>): string[] {
  return criteria
    .filter((c) => {
      const a = answers[c.key];
      if (!a) return false;
      if (a.type === "noul") return a.noul > 0.35 && a.noul < 0.65;
      return typeof a.confidence === "number" && a.confidence < 0.5;
    })
    .map((c) => c.key);
}

function shownValue(c: Criterion, a: JevAnswer | undefined): string {
  if (!a) return "";
  if (a.type === "score") return `${a.score.toFixed(1)}/${c.levels.length - 1}`;
  if (a.type === "noul") return `${Math.round(a.noul * 100)}% yes`;
  return a.choice;
}

function csvValue(a: JevAnswer | undefined): string | number {
  if (!a) return "";
  if (a.type === "score") return Number(a.score.toFixed(2));
  if (a.type === "noul") return Number(a.noul.toFixed(3));
  return a.choice;
}

// ---- items and files ---------------------------------------------------------

/** A file name under files/: a plain base name, never a dot file, always .csv. */
export function csvFileName(raw: unknown, fallback = "scores"): string {
  const base = typeof raw === "string" ? path.basename(raw.trim()) : "";
  const stem = base
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .replace(/[^A-Za-z0-9 _.-]+/g, "-")
    .replace(/^[.\s-]+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${stem || fallback}.csv`;
}

/** RFC 4180-ish CSV: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
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

/** CSV text. Text cells that a spreadsheet would run as a formula get a leading '. */
export function toCsv(rows: Array<Array<string | number | null | undefined>>): string {
  const cell = (v: string | number | null | undefined) => {
    if (v === null || v === undefined) return "";
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
    let s = v;
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\n") + "\n";
}

function filesDir(ctx: TethrToolContext): string {
  return path.join(ctx.workspaceDir, FILES_DIR);
}

/** Read a list from a file in files/ (confined there). */
export async function readListFile(raw: string, ctx: TethrToolContext): Promise<unknown[] | string> {
  const rel = raw.trim().replace(/^\.?\/?files\//, "");
  const root = path.resolve(filesDir(ctx));
  const abs = path.resolve(root, rel);
  const inside = path.relative(root, abs);
  if (!rel || !inside || inside.startsWith("..") || path.isAbsolute(inside) || inside.split(path.sep).some((p) => p.startsWith("."))) {
    return "from_file must be a file in ./files/.";
  }
  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch {
    return `There's no file called ${rel} in ./files/.`;
  }
  if (!stat.isFile()) return `${rel} isn't a file.`;
  if (stat.size > SCORE_LIMITS.fileBytes) return `${rel} is too big (over 2 MB).`;
  const text = await fsp.readFile(abs, "utf8");
  const ext = path.extname(abs).toLowerCase();
  if (ext === ".json") {
    try {
      const parsed = JSON.parse(text) as unknown;
      const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown }).items) ? (parsed as { items: unknown[] }).items : null;
      return list ?? `${rel} isn't a JSON list.`;
    } catch {
      return `${rel} isn't valid JSON.`;
    }
  }
  if (ext === ".csv") {
    const rows = parseCsv(text);
    if (rows.length < 2) return `${rel} has no rows under its header.`;
    const header = rows[0].map((h, i) => slug(h) || `col_${i + 1}`);
    return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
  }
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
}

const LABEL_KEYS = ["text", "keyword", "name", "title", "company", "url", "label", "item"];

export function itemLabel(item: unknown): string {
  if (typeof item === "string") return item;
  if (typeof item === "number" || typeof item === "boolean") return String(item);
  if (item && typeof item === "object" && !Array.isArray(item)) {
    for (const k of LABEL_KEYS) {
      const v = (item as Record<string, unknown>)[k];
      if (typeof v === "string" && v.trim()) return v;
    }
  }
  return JSON.stringify(item) ?? "";
}

const cellText = (s: string, max = 80) => {
  const flat = s.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

async function mapPool<T, R>(list: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(list.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(n, list.length)) }, async () => {
      while (next < list.length) {
        const i = next++;
        out[i] = await fn(list[i], i);
      }
    }),
  );
  return out;
}

function stamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

// ---- score_list -------------------------------------------------------------

interface Scored {
  index: number;
  item: unknown;
  label: string;
  answers?: Record<string, JevAnswer>;
  composite: number | null;
  uncertain: string[];
  error?: string;
}

export async function runScoreList(args: Record<string, unknown>, ctx: TethrToolContext): Promise<TethrToolResult> {
  if (!jevConfigured()) {
    return {
      text: "Jev isn't set up in Tethr yet (no TYPESAFE_API_KEY), so nothing was scored. Score the items yourself this time, and mention that adding a Jev key makes this instant.",
      isError: true,
      meta: { configured: false },
    };
  }
  const criteria = parseCriteria(args.criteria);
  if (typeof criteria === "string") return { text: `score_list: ${criteria}`, isError: true };
  const context = typeof args.context === "string" ? args.context.trim() : "";
  if (context.length > SCORE_LIMITS.contextChars) return { text: "score_list: context is over 4,000 characters; shorten it.", isError: true };

  let items: unknown[];
  const fromFile = typeof args.from_file === "string" && args.from_file.trim() ? args.from_file.trim() : null;
  if (fromFile) {
    const loaded = await readListFile(fromFile, ctx);
    if (typeof loaded === "string") return { text: `score_list: ${loaded}`, isError: true };
    items = loaded;
  } else if (Array.isArray(args.items)) {
    items = args.items;
  } else {
    return { text: "score_list: give items or from_file.", isError: true };
  }
  items = items.filter((i) => i !== null && i !== undefined && !(typeof i === "string" && !i.trim()));
  if (!items.length) return { text: "score_list: the list is empty.", isError: true };
  // A file over the limit scores its first rows (keyword_ideas files are sorted
  // by volume, so that's the most-searched ones) instead of failing.
  let note = "";
  if (items.length > SCORE_LIMITS.items) {
    if (!fromFile) return { text: `score_list: that's ${items.length} items; the limit is ${SCORE_LIMITS.items} per call. Split the list, or save it to a file and use from_file.`, isError: true };
    note = `Only the first ${SCORE_LIMITS.items} of ${items.length} rows in ${path.basename(fromFile)} were scored (the limit per call).`;
    items = items.slice(0, SCORE_LIMITS.items);
  }

  const questions = jevQuestions(criteria);
  const started = Date.now();
  let tokens = 0;
  let model = "";
  let fatal: string | null = null;
  const scored = await mapPool(items, ctx.concurrency ?? SCORE_LIMITS.concurrency, async (item, index): Promise<Scored> => {
    const label = itemLabel(item);
    const base: Scored = { index, item, label, composite: null, uncertain: [] };
    if (fatal) return { ...base, error: fatal };
    if ((JSON.stringify(item) ?? "").length > SCORE_LIMITS.itemChars) return { ...base, error: "too long (over 4,000 characters)" };
    try {
      const res = await jevAsk(context ? { context, item } : item, questions, ctx.jev);
      tokens += res.usage.input_tokens;
      model = res.model;
      return { ...base, answers: res.answers, composite: compositeOf(criteria, res.answers), uncertain: uncertainOf(criteria, res.answers) };
    } catch (err) {
      const msg = err instanceof JevError ? err.message : `Jev failed: ${err instanceof Error ? err.message : String(err)}`;
      // A bad key or a malformed question fails every item the same way: stop.
      if (err instanceof JevError && (err.status === 401 || err.status === 422)) fatal = msg;
      return { ...base, error: msg };
    }
  });
  const ms = Date.now() - started;
  const ok = scored.filter((s) => !s.error);
  const failed = scored.filter((s) => s.error);
  const meta = { items: items.length, scored: ok.length, failed: failed.length, inputTokens: tokens, ms, model: model || null, criteria: criteria.length };
  if (!ok.length) {
    return { text: `score_list: nothing was scored. ${failed[0]?.error ?? ""}`.trim(), isError: true, meta };
  }

  const ranked = [...ok].sort((a, b) => (b.composite ?? -1) - (a.composite ?? -1) || a.index - b.index);
  const hasComposite = ranked.some((s) => s.composite !== null);
  const top = Math.max(1, Math.min(100, Math.floor(Number(args.top) || SCORE_LIMITS.top)));

  // Every row to a CSV when asked, or when the reply only shows part of the list.
  let file: string | undefined;
  if ((typeof args.save_as === "string" && args.save_as.trim()) || ranked.length > top || failed.length) {
    const name = csvFileName(args.save_as, `scores-${stamp(ctx.now?.() ?? new Date())}`);
    const extra = new Set<string>();
    for (const s of scored) {
      if (s.item && typeof s.item === "object" && !Array.isArray(s.item)) {
        for (const [k, v] of Object.entries(s.item as Record<string, unknown>)) if (v === null || typeof v !== "object") extra.add(k);
      }
    }
    const ours = new Set(["rank", "item", "composite", "check", "error", ...criteria.map((c) => c.key)]);
    const extraCols = [...extra].map((k) => ({ k, col: ours.has(k) ? `src_${k}` : k }));
    const header = ["rank", "item", ...(hasComposite ? ["composite"] : []), ...criteria.map((c) => c.key), "check", ...(failed.length ? ["error"] : []), ...extraCols.map((e) => e.col)];
    const row = (s: Scored, rank: number | null) => [
      rank,
      s.label,
      ...(hasComposite ? [s.composite === null ? null : Math.round(s.composite * 100)] : []),
      ...criteria.map((c) => csvValue(s.answers?.[c.key])),
      s.uncertain.join(" "),
      ...(failed.length ? [s.error ?? ""] : []),
      ...extraCols.map((e) => {
        const v = s.item && typeof s.item === "object" ? (s.item as Record<string, unknown>)[e.k] : undefined;
        return typeof v === "number" ? v : v === undefined || v === null ? "" : String(v);
      }),
    ];
    const rows = [header, ...ranked.map((s, i) => row(s, i + 1)), ...failed.map((s) => row(s, null))];
    file = await saveCsv(ctx, name, rows);
  }

  const describe = (c: Criterion) => {
    const kind = c.type === "score" ? `score 0-${c.levels.length - 1}` : c.type === "yes_no" ? (c.want === "no" ? "yes/no, no is better" : "yes/no") : "choice";
    return `${c.key} (${kind}${c.weight > 0 && hasComposite ? `, weight ${c.weight}` : ""})`;
  };
  const shown = ranked.slice(0, top);
  const lines = [
    `Scored ${ok.length} of ${items.length} items with Jev (${model || "jev"}) in ${(ms / 1000).toFixed(1)}s, about $${jevCostUsd(tokens).toFixed(4)}.`,
    `${hasComposite ? "Ranked by" : "Criteria"}: ${criteria.map(describe).join(", ")}.`,
    ...(note ? [note] : []),
    "",
    `| # | Item | ${hasComposite ? "Score | " : ""}${criteria.map((c) => c.key).join(" | ")} | Check |`,
    `|---|---|${hasComposite ? "---|" : ""}${criteria.map(() => "---").join("|")}|---|`,
    ...shown.map(
      (s, i) =>
        `| ${i + 1} | ${cellText(s.label)} | ${hasComposite ? `${s.composite === null ? "" : Math.round(s.composite * 100)} | ` : ""}${criteria.map((c) => shownValue(c, s.answers?.[c.key])).join(" | ")} | ${s.uncertain.join(" ")} |`,
    ),
  ];
  if (ranked.length > shown.length) lines.push("", `${ranked.length - shown.length} more in the CSV.`);
  if (failed.length) {
    lines.push("", `Couldn't score ${failed.length}: ${failed.slice(0, 5).map((s) => `"${cellText(s.label, 40)}" (${s.error})`).join("; ")}${failed.length > 5 ? "; ..." : ""}`);
  }
  if (ranked.some((s) => s.uncertain.length)) lines.push("", "Check = criteria Jev wasn't sure about for that item; worth a human look.");
  if (file) lines.push("", `All rows: ${file}`, savedFileLine(file));
  return { text: lines.join("\n"), file, meta };
}

// ---- keyword_ideas --------------------------------------------------------------

export async function runKeywordIdeas(args: Record<string, unknown>, ctx: TethrToolContext): Promise<TethrToolResult> {
  const seeds = Array.isArray(args.seeds) ? args.seeds.map((s) => str(s, 80)).filter(Boolean) : [];
  if (!seeds.length) return { text: "keyword_ideas: give at least one seed phrase.", isError: true };
  if (seeds.length > 20) return { text: "keyword_ideas: use at most 20 seeds.", isError: true };
  const geoRaw = Array.isArray(args.geo_target_ids) ? args.geo_target_ids.map((g) => String(g).trim()) : [];
  const geo = geoRaw.filter((g) => /^\d{1,10}$/.test(g));
  if (geoRaw.length && geo.length !== geoRaw.length) return { text: "keyword_ideas: geo_target_ids must be numeric Google geo ids (2840 = United States).", isError: true };
  if (!ctx.keywordIdeas && !googleAdsConfigured()) {
    return { text: "Google Keyword Planner isn't set up in Tethr (the GOOGLE_ADS_* settings are missing).", isError: true };
  }
  const limit = Math.max(1, Math.min(500, Math.floor(Number(args.limit) || 50)));
  const started = Date.now();
  let ideas: KeywordIdea[];
  try {
    ideas = await (ctx.keywordIdeas ?? generateKeywordIdeas)(seeds, geo.length ? geo : undefined);
  } catch (err) {
    const msg = err instanceof KeywordPlannerAccessError ? err.message : `Keyword Planner failed: ${err instanceof Error ? err.message : String(err)}`;
    return { text: `keyword_ideas: ${msg}`, isError: true };
  }
  const meta = { seeds: seeds.length, ideas: ideas.length, ms: Date.now() - started };
  if (!ideas.length) return { text: "keyword_ideas: Google returned no ideas for those seeds.", meta };
  const sorted = [...ideas].sort((a, b) => b.monthlySearchVolume - a.monthlySearchVolume);

  let file: string | undefined;
  if ((typeof args.save_as === "string" && args.save_as.trim()) || sorted.length > limit) {
    const name = csvFileName(args.save_as, `keyword-ideas-${stamp(ctx.now?.() ?? new Date())}`);
    const rows = [
      ["keyword", "monthly_searches", "competition", "avg_cpc", "low_top_bid", "high_top_bid"],
      ...sorted.map((k) => [k.text, k.monthlySearchVolume, k.competition, k.averageCpc, k.lowTopOfPageCpc, k.highTopOfPageCpc]),
    ];
    file = await saveCsv(ctx, name, rows);
  }
  const where = geo.length && !(geo.length === 1 && geo[0] === "2840") ? `geo ${geo.join(", ")}` : "US";
  const shown = sorted.slice(0, limit);
  const lines = [
    `${sorted.length} keyword ideas from ${seeds.map((s) => `"${s}"`).join(", ")} (Google Keyword Planner, ${where}). Top ${shown.length} by monthly searches:`,
    "",
    "| Keyword | Monthly searches | Competition | Avg CPC |",
    "|---|---|---|---|",
    ...shown.map((k) => `| ${cellText(k.text)} | ${k.monthlySearchVolume} | ${k.competition} | $${k.averageCpc.toFixed(2)} |`),
  ];
  if (file) lines.push("", `All ${sorted.length} ideas: ${file} (rank them with score_list, from_file: "${file.slice(FILES_DIR.length + 1)}").`, savedFileLine(file));
  return { text: lines.join("\n"), file, meta };
}

// ---- goals (phase 20) --------------------------------------------------------------

async function runGoalTool(name: string, args: Record<string, unknown>, ctx: TethrToolContext): Promise<TethrToolResult> {
  if (!ctx.db || !ctx.companyId) return { text: `${name}: goals aren't available here.`, isError: true };
  const svc = goalsService(ctx.db);
  if (name === "goals_list") {
    const view = await svc.list(ctx.companyId);
    return { text: goalsContextText(view), meta: { goals: view.goals.length } };
  }
  if (name === "save_goal") {
    // The top goal follows the company's name and tethr's built-in mission; the
    // chat saves goal areas only.
    if (typeof args.id === "string" && args.id) {
      const view = await svc.list(ctx.companyId);
      if (view.company?.id === args.id) {
        return { text: "save_goal: the top goal follows the company's name and tethr's mission; save or change a goal area instead.", isError: true };
      }
    }
    const g = await svc.saveGoal(ctx.companyId, { ...args, level: "team" });
    return { text: `Saved goal "${g.title}" [goal ${g.id}].`, meta: { goalId: g.id } };
  }
  if (name === "save_metric") {
    const m = await svc.saveMetric(ctx.companyId, args);
    return { text: `Saved metric "${m.name}" [metric ${m.id}] on goal ${m.goalId}.`, meta: { metricId: m.id } };
  }
  const metricId = typeof args.metric_id === "string" ? args.metric_id : "";
  if (!metricId) return { text: "record_metric: give metric_id.", isError: true };
  const m = await svc.recordMeasurement(ctx.companyId, metricId, { value: args.value, at: args.at, note: args.note });
  return { text: `Recorded ${m.current} for "${m.name}" (${m.currentAt?.toISOString().slice(0, 10)}).`, meta: { metricId: m.id } };
}

/** Run one Tethr tool. Never throws: errors come back as an error result. */
export async function runTethrTool(name: string, args: unknown, ctx: TethrToolContext): Promise<TethrToolResult> {
  const a = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  try {
    if (name === "score_list") return await runScoreList(a, ctx);
    if (name === "keyword_ideas") return await runKeywordIdeas(a, ctx);
    if (name === "goals_list" || name === "save_goal" || name === "save_metric" || name === "record_metric") {
      return await runGoalTool(name, a, ctx);
    }
    return { text: `There's no Tethr tool called ${name}.`, isError: true };
  } catch (err) {
    if (err instanceof GoalInputError) return { text: `${name}: ${err.message}`, isError: true };
    return { text: `Tethr tools: ${name} failed (${err instanceof Error ? err.message : String(err)}).`, isError: true };
  }
}
