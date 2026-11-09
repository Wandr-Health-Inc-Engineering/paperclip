import type { SlackReplyTarget } from "./gate.js";
import crypto from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tethrOutputs } from "@paperclipai/db";
import type { TethrSensitivity } from "@paperclipai/shared";
import { gatingService } from "../gating.js";
import { orgService } from "../org.js";
import type { Classified } from "./policy.js";

// Approval grants for the Chat's outward actions (phase 18). When the gate holds
// a call it becomes a gated Tethr output (kind "external_action") — an inline
// card in the chat, a Queue item, a Slack DM. Approving it arms a ONE-TIME grant
// bound to the thread and to a hash of the exact tool input; the next identical
// call consumes it atomically (no replay, no race). Grants expire after 24h.

export const GRANT_TTL_MS = 24 * 60 * 60 * 1000;

function canonical(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const s = value.normalize("NFC").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "");
    return s === "" ? undefined : s;
  }
  if (Array.isArray(value)) return value.map(canonical).filter((v) => v !== undefined);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = canonical((value as Record<string, unknown>)[key]);
      if (v !== undefined && !(Array.isArray(v) && v.length === 0)) out[key] = v;
    }
    return out;
  }
  return value;
}

/** Stable JSON for hashing: sorted keys, normalized text, empty values dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value) ?? null);
}

export function inputHash(toolName: string, toolInput: unknown): string {
  return crypto.createHash("sha256").update(`${toolName}\n${canonicalJson(toolInput)}`).digest("hex");
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

function sensitivityFor(c: Classified): TethrSensitivity {
  if (c.cls === "medical") return "medical";
  if (c.cls === "public") return "public";
  if (c.cls === "money") return "spend";
  if (c.cls === "destructive") return "destructive";
  return "external";
}

const asList = (v: unknown): string =>
  Array.isArray(v)
    ? v.map((x) => (typeof x === "object" && x ? String((x as Record<string, unknown>).email ?? JSON.stringify(x)) : String(x))).join(", ")
    : typeof v === "object" && v
      ? JSON.stringify(v)
      : String(v ?? "");

/** The longest call the gate will hold for approval: anything bigger can't be
 * reviewed properly on a card, so it's refused instead of shown truncated. */
export const MAX_APPROVAL_INPUT_CHARS = 30_000;

/** A plain-text preview of EXACTLY what will happen, for the approval card.
 * Every field of the call is shown, nothing is truncated, and the UI renders it
 * as plain text (never Markdown), so what Mark approves is what gets sent. */
export function describeAction(c: Classified, input: Record<string, unknown>): string {
  const lines: string[] = [];
  const shown = new Set<string>();
  const add = (label: string, ...keys: string[]) => {
    const key = keys.find((k) => input[k] !== undefined && input[k] !== null && input[k] !== "");
    for (const k of keys) shown.add(k);
    if (!key) return;
    const s = asList(input[key]).trim();
    if (s) lines.push(`${label}: ${s}`);
  };
  let body: string | null = null;
  const bodyOf = (...keys: string[]) => {
    for (const k of keys) shown.add(k);
    const key = keys.find((k) => typeof input[k] === "string" && (input[k] as string).trim());
    body = key ? (input[key] as string) : null;
  };
  if (c.connector === "Gmail") {
    add("To", "to");
    add("Cc", "cc");
    add("Bcc", "bcc");
    add("Subject", "subject");
    bodyOf("body");
  } else if (c.connector === "Slack") {
    add("Channel", "channel_id", "channel", "channel_name");
    bodyOf("message", "text");
  } else if (c.connector === "Google Calendar") {
    add("Title", "summary", "title");
    add("Start", "start");
    add("End", "end");
    add("Attendees", "attendees");
  } else if (c.tool === "Bash") {
    bodyOf("command");
  } else if (c.tool === "WebFetch") {
    add("Page", "url");
    add("Looking for", "prompt");
  }
  // Every other field, so nothing that will be sent is hidden from the card.
  const rest = Object.fromEntries(Object.entries(input).filter(([k, v]) => !shown.has(k) && v !== undefined && v !== null && v !== ""));
  if (Object.keys(rest).length) lines.push(`${lines.length ? "Other fields" : "Details"}: ${JSON.stringify(rest, null, 2)}`);
  if (body) lines.push("", body);
  return [c.summary, "", ...lines].join("\n");
}

export interface PendingActionInput {
  companyId: string;
  threadId: string;
  runId: string;
  classified: Classified;
  toolName: string;
  toolInput: Record<string, unknown>;
  hash: string;
  /** The team agent asking (phase 23), so the card names it and its owner hears. Default @tethr. */
  actor?: { agentId: string; tag: string };
  /** Phase 26.1: the turn came from Slack; the card is asked in that Slack conversation. */
  slack?: SlackReplyTarget;
}

/** Hold an outward action for Mark: a gated external_action output. */
export async function createPendingAction(db: Db, input: PendingActionInput) {
  const router = await orgService(db).getRouterProfile(input.companyId);
  if (!router) throw new Error("No @tethr agent in this company");
  return gatingService(db).createOutput({
    companyId: input.companyId,
    agentId: input.actor?.agentId ?? router.agent.id,
    agentTag: input.actor?.tag ?? router.profile.tag,
    routeRunId: input.runId,
    kind: "external_action",
    title: input.classified.summary.slice(0, 160),
    body: describeAction(input.classified, input.toolInput),
    sensitivity: sensitivityFor(input.classified),
    meta: {
      threadId: input.threadId,
      toolName: input.toolName,
      toolInput: input.toolInput,
      inputHash: input.hash,
      connector: input.classified.connector,
      cls: input.classified.cls,
      summary: input.classified.summary,
      grant: { status: "pending" },
      ...(input.slack ? { slack: input.slack } : {}),
    },
  });
}

/** A card for the same call that is still waiting on Mark, if any. */
export async function findPending(db: Db, companyId: string, threadId: string, hash: string) {
  const [row] = await db
    .select({ id: tethrOutputs.id })
    .from(tethrOutputs)
    .where(
      and(
        eq(tethrOutputs.companyId, companyId),
        eq(tethrOutputs.kind, "external_action"),
        sql`${tethrOutputs.status} in ('gated', 'changes_requested')`,
        sql`${tethrOutputs.meta}->>'inputHash' = ${hash}`,
        sql`${tethrOutputs.meta}->>'threadId' = ${threadId}`,
      ),
    )
    .orderBy(desc(tethrOutputs.createdAt))
    .limit(1);
  return row ?? null;
}

/** Atomically use one approved, unexpired grant for this exact call. Returns its id. */
export async function consumeGrant(db: Db, companyId: string, threadId: string, hash: string): Promise<string | null> {
  const result = await db.execute(sql`
    with pick as (
      select id from tethr_outputs
      where company_id = ${companyId}
        and kind = 'external_action'
        and status = 'approved'
        and meta->>'inputHash' = ${hash}
        and meta->>'threadId' = ${threadId}
        and meta->'grant'->>'status' = 'active'
        and (meta->'grant'->>'expiresAt')::timestamptz > now()
      order by created_at
      limit 1
      for update skip locked
    )
    update tethr_outputs o
       set meta = jsonb_set(o.meta, '{grant,status}', '"used"'::jsonb),
           updated_at = now()
      from pick
     where o.id = pick.id
    returning o.id
  `);
  const rows = Array.from(result as Iterable<{ id: string }>);
  return rows[0]?.id ?? null;
}

/** After an approved call ran: close its card as done. */
export async function recordOutcome(db: Db, companyId: string, threadId: string, hash: string): Promise<void> {
  await db.execute(sql`
    update tethr_outputs
       set status = 'published',
           published_at = now(),
           meta = jsonb_set(meta, '{grant,doneAt}', to_jsonb(now()::text)),
           updated_at = now()
     where id = (
       select id from tethr_outputs
        where company_id = ${companyId}
          and kind = 'external_action'
          and status = 'approved'
          and meta->>'inputHash' = ${hash}
          and meta->>'threadId' = ${threadId}
          and meta->'grant'->>'status' = 'used'
        order by updated_at desc
        limit 1)
  `);
}

/** An approved call that ran but came back with an error: the card says so
 * instead of "sent" (status stays approved; the grant is spent). */
export async function recordFailure(db: Db, companyId: string, threadId: string, hash: string): Promise<void> {
  await db.execute(sql`
    update tethr_outputs
       set meta = jsonb_set(jsonb_set(meta, '{grant,status}', '"failed"'::jsonb), '{grant,failedAt}', to_jsonb(now()::text)),
           updated_at = now()
     where id = (
       select id from tethr_outputs
        where company_id = ${companyId}
          and kind = 'external_action'
          and status = 'approved'
          and meta->>'inputHash' = ${hash}
          and meta->>'threadId' = ${threadId}
          and meta->'grant'->>'status' = 'used'
        order by updated_at desc
        limit 1)
  `);
}
