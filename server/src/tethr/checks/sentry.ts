// Sentry — the Reliability-division site auditor (Phase 4). This module owns
// the audit *policy*: which public pages to check, what structured data each
// should carry, and how a finding becomes a #scout recommendation in the
// standard Phase 2 format. The check mechanics live in ./site-audit.ts.
//
// Scope is public, read-only, structural. Never medical-content correctness.

import type { Db } from "@paperclipai/db";
import { memoryService } from "../memory.js";
import { notificationService } from "../notify.js";
import { buildRecommendation, type RecommendationInput } from "../recommendation.js";
import {
  runSiteAudit,
  selectFindingsToPost,
  type AuditDeps,
  type SiteFinding,
} from "./site-audit.js";

/** Public site root; override for staging with TETHR_SENTRY_SITE. */
export function siteRoot(): string {
  return (process.env.TETHR_SENTRY_SITE?.trim() || "https://travelwithwandr.com").replace(/\/$/, "");
}

export interface SentryPage {
  path: string;
  expectJsonLdTypes?: string[];
}

// v1 fixed page list. Home + a representative destination + travel-medicine +
// the blog index. The "/blog latest 10" crawl is a later enhancement (needs to
// read the blog index and follow the 10 newest links); this list is the audited
// core and is confirmable/extensible by Mark without code (see MANUAL-STEPS).
export const SENTRY_PAGES: SentryPage[] = [
  { path: "/", expectJsonLdTypes: ["Organization"] },
  { path: "/destinations", expectJsonLdTypes: [] },
  { path: "/travel-medicine", expectJsonLdTypes: ["MedicalWebPage"] },
  { path: "/blog", expectJsonLdTypes: [] },
];

export function sentryAuditPages(): Array<{ url: string; expectJsonLdTypes?: string[] }> {
  const root = siteRoot();
  return SENTRY_PAGES.map((p) => ({ url: root + p.path, expectJsonLdTypes: p.expectJsonLdTypes }));
}

/** Map a structural finding to the standard agent-recommendation input. */
export function findingToRecommendation(f: SiteFinding): RecommendationInput {
  return {
    agentCodename: "Sentry",
    title: f.title,
    why: f.why,
    affectedUrl: f.url,
    severity: f.severity,
    details: f.detail,
  };
}

/** Build the Slack-ready recommendation ({text, body, blocks}) for a finding. */
export function findingToSlack(f: SiteFinding) {
  return buildRecommendation(findingToRecommendation(f));
}

// ---- Runner (used by the tethr_llm adapter's site_audit heartbeat mode) ----

const DEDUPE_DAYS = 14;
const MEMO_MARK = "sentry:fp:";

export interface SentryRunResult {
  scanned: number;
  findings: number;
  posted: number;
  dryRun: boolean;
  postedFindings: Array<{ fingerprint: string; title: string; severity: string; url: string }>;
}

/** Real read-only HTTP deps (12s timeout, polite UA); network errors don't false-flag. */
function realFetchDeps(): AuditDeps {
  const ua = "TethrSentry/1.0 (+https://travelwithwandr.com; read-only auditor)";
  const withTimeout = async (url: string, method: "GET" | "HEAD") => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    try {
      return await fetch(url, { method, redirect: "follow", headers: { "user-agent": ua }, signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }
  };
  return {
    async fetchPage(url) {
      try {
        const res = await withTimeout(url, "GET");
        return { status: res.status, html: await res.text() };
      } catch {
        return null;
      }
    },
    async linkStatus(url) {
      try {
        return (await withTimeout(url, "GET")).status;
      } catch {
        return 0; // network error → not flagged (avoid false positives)
      }
    },
    maxLinksPerPage: 20,
  };
}

/** Fingerprints recorded within the 14-day dedupe window (the fingerprint lives in memory content). */
async function seenFingerprints(db: Db, companyId: string, agentId: string): Promise<Set<string>> {
  const rows = await memoryService(db).recall(companyId, agentId, MEMO_MARK, 200);
  const cutoff = Date.now() - DEDUPE_DAYS * 24 * 60 * 60 * 1000;
  const seen = new Set<string>();
  const re = new RegExp(`${MEMO_MARK}([^\\]\\s]+)`);
  for (const r of rows) {
    const created = r.createdAt ? new Date(r.createdAt).getTime() : 0;
    if (created < cutoff) continue;
    const m = re.exec(r.content ?? "");
    if (m) seen.add(m[1]);
  }
  return seen;
}

/**
 * Run the public-site audit: fetch the fixed page list, run the checks, dedupe
 * against the 14-day memory, cap at 3 highest-severity findings, and — unless
 * dryRun — post each to #scout (via the Notifier, so Slack only fires with a
 * token) and record it. `deps` is injectable for tests.
 */
export async function runSentryAudit(
  db: Db,
  companyId: string,
  agentId: string,
  opts: { dryRun?: boolean; deps?: AuditDeps } = {},
): Promise<SentryRunResult> {
  const deps = opts.deps ?? realFetchDeps();
  const pages = sentryAuditPages();
  const all = await runSiteAudit(pages, deps);
  const seen = await seenFingerprints(db, companyId, agentId);
  const toPost = selectFindingsToPost(all, { seenFingerprints: seen, maxPerRun: 3 });
  const postedFindings = toPost.map((f) => ({
    fingerprint: f.fingerprint,
    title: f.title,
    severity: f.severity,
    url: f.url,
  }));

  if (opts.dryRun) {
    return { scanned: pages.length, findings: all.length, posted: 0, dryRun: true, postedFindings };
  }

  const notify = notificationService(db);
  const memory = memoryService(db);
  for (const f of toPost) {
    const rec = findingToSlack(f);
    await notify.send({
      companyId,
      kind: "system",
      title: f.title,
      body: rec.body,
      href: f.url,
      agentTag: "@sentry",
      slackBlocks: rec.blocks,
    });
    await memory.record({
      companyId,
      agentId,
      kind: "fact",
      content: `[${MEMO_MARK}${f.fingerprint}] ${f.title}`,
      source: f.url,
    });
  }
  return { scanned: pages.length, findings: all.length, posted: toPost.length, dryRun: false, postedFindings };
}
