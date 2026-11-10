import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tethrInboxItems, tethrMembers, tethrRouteRuns, type InboxSuggestion } from "@paperclipai/db";
import { writeNewFile } from "../atomic.js";
import { logFailure } from "../best-effort.js";
import * as chats from "../chats.js";
import { companyProfileService } from "../company.js";
import { decideWithJev, resolveDecision, type ChoiceAsk, type ChoiceOption, type DecideDeps } from "../decide/decide.js";
import { existingFsPath, fsMove } from "../fsdrive.js";
import { mirrorDir } from "../mirror.js";
import { positionOf } from "../positions.js";
import { needsPersonReason } from "../screen.js";
import { teamService } from "../team.js";
import { DAY } from "../time.js";
import { readFileText } from "./read.js";
import { activeRules, inboxStore, SAMPLES_KEPT, type FilingRule } from "./store.js";

// The Inbox (phase 26.3): send tethr a file and it files it or routes it.
// 1. It arrives: the Drive's 00 Tethr/00 Inbox folder (once it stops changing),
//    "File this" on a chat upload, or a file sent to tethr alone in Slack.
// 2. tethr reads it on the Mac (text, Office, PDF; images by name).
// 3. The check on the Mac: a person's health details, a card number or a key
//    means a person looks first. Nothing is sent to Jev, nothing is filed.
// 4. Jev decides in one request: what it is, where it goes (one of the real
//    folders), who should know, how soon.
// 5. tethr acts: a card to tap (Suggest), or it files it (Automatic, with "Put it
//    back" for 7 days). It never deletes; it tells people a file's name and
//    where it went, never what's in it.
// 6. It learns: every tap is in the decision record, folders get profiles from
//    what's filed there, and two corrections the same way propose a rule.

export const INBOX_DIR = "00 Inbox";
export const INBOX_CARD_SOURCE = "tethr-inbox";
export const UNDO_DAYS = 7;
export const STABLE_MS = 30_000;
export const MAX_FOLDERS = 40;
/** How much of a file's text Jev sees. */
export const JEV_TEXT_CHARS = 6_000;

export const ITEM_TYPES = ["invoice", "contract", "partner material", "research", "report", "other"] as const;
export const URGENCIES = ["today", "this week", "whenever"] as const;
export const NOBODY = "Nobody";

export type InboxItem = typeof tethrInboxItems.$inferSelect;

export class InboxError extends Error {}

/** The folders tethr never files into: its Inbox, the archive, its own workspace, anything hidden. */
export function protectedFolder(rel: string): boolean {
  const parts = rel.split("/").filter(Boolean);
  if (!parts.length) return true;
  const workspace = process.env.TETHR_WORKSPACE_SUBDIR || "tethr";
  return [INBOX_DIR, "99 Archive", workspace].includes(parts[0]) || parts.some((p) => p.startsWith("."));
}

export const folderLabel = (rel: string) => rel.split("/").join(" / ");

/** Where a file can go: the real folders in 00 Tethr, two levels deep. */
export async function destinationFolders(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (protectedFolder(child)) continue;
      out.push(child);
      if (depth < 2) await walk(child, depth + 1);
    }
  };
  await walk("", 1);
  return out.slice(0, MAX_FOLDERS);
}

function folderOptions(companyId: string, folders: string[], root: string): ChoiceOption[] {
  const profiles = inboxStore.get(companyId).folders ?? {};
  return folders.map((rel, i) => {
    const p = profiles[rel];
    let samples = p?.samples ?? [];
    if (!samples.length) {
      try {
        samples = fs
          .readdirSync(path.join(root, rel), { withFileTypes: true })
          .filter((e) => e.isFile() && !e.name.startsWith("."))
          .slice(0, 4)
          .map((e) => e.name);
      } catch {
        samples = [];
      }
    }
    const bits = [p?.description, samples.length ? `holds files like ${samples.slice(-4).join(", ")}` : null].filter(Boolean);
    return { key: `f${i + 1}`, label: folderLabel(rel), description: bits.length ? `${folderLabel(rel)}: ${bits.join("; ")}` : folderLabel(rel) };
  });
}

async function notifyOptions(db: Db, companyId: string): Promise<ChoiceOption[]> {
  const members = await db.select().from(tethrMembers).where(and(eq(tethrMembers.companyId, companyId), eq(tethrMembers.status, "active")));
  const agents = (await teamService(db).list(companyId)).filter((a) => !a.paused);
  return [
    { key: "n0", label: NOBODY, description: "Nobody needs to know; it just needs filing." },
    ...members.map((m, i) => ({ key: `m${i + 1}`, label: m.name, description: `${m.name}, ${m.title || positionOf(m.position).title}: ${positionOf(m.position).focus}.` })),
    ...agents.map((a, i) => ({ key: `a${i + 1}`, label: a.tag, description: `The agent ${a.tag} (${a.title}): ${a.mission}` })),
  ];
}

const choice = (values: readonly string[], prefix: string): ChoiceOption[] => values.map((v, i) => ({ key: `${prefix}${i + 1}`, label: v, description: v }));

export interface InboxDeps extends DecideDeps {
  /** Tell a person (bell + Slack DM) — replaced in tests. */
  tell?: (db: Db, companyId: string, who: string, text: string) => Promise<void>;
}

/** Tell a person or an agent's owner about a file: the bell, and a Slack DM with its name and where it went. */
async function tellPerson(db: Db, companyId: string, who: string, text: string): Promise<void> {
  const { notificationService } = await import("../notify.js");
  await notificationService(db).send({ companyId, kind: "inbox", title: text, href: "/drive?view=inbox" }).catch(logFailure("inbox bell"));
  const [member] = await db
    .select()
    .from(tethrMembers)
    .where(and(eq(tethrMembers.companyId, companyId), eq(tethrMembers.name, who)))
    .limit(1);
  const slack = await import("../slack.js");
  if (!member?.slackUserId || !slack.slackConfigured()) return;
  await slack.postSlackMessage({ channel: member.slackUserId, text }).catch(logFailure("inbox Slack DM"));
}

export function inboxService(db: Db, deps: InboxDeps = {}) {
  const now = () => deps.now ?? new Date();
  const tell = deps.tell ?? tellPerson;

  async function get(companyId: string, id: string): Promise<InboxItem> {
    const [item] = await db.select().from(tethrInboxItems).where(and(eq(tethrInboxItems.id, id), eq(tethrInboxItems.companyId, companyId)));
    if (!item) throw new InboxError("There's no such item in tethr's Inbox.");
    return item;
  }

  async function update(id: string, patch: Partial<typeof tethrInboxItems.$inferInsert>): Promise<InboxItem> {
    const [row] = await db.update(tethrInboxItems).set({ ...patch, updatedAt: now() }).where(eq(tethrInboxItems.id, id)).returning();
    return row;
  }

  function rootOrThrow(): string {
    const root = mirrorDir();
    if (!root) throw new InboxError("The shared Drive folder (00 Tethr) isn't connected, so tethr can't file anything.");
    return root;
  }

  /** The card in the main chat (one per item; the page reads the item for its buttons). */
  async function card(item: InboxItem, line: string): Promise<InboxItem> {
    if (item.cardRunId) {
      await db.update(tethrRouteRuns).set({ resultText: line, updatedAt: now() }).where(eq(tethrRouteRuns.id, item.cardRunId));
      return item;
    }
    const at = now();
    const [run] = await db
      .insert(tethrRouteRuns)
      .values({
        companyId: item.companyId,
        requestText: `Inbox · ${item.name}`,
        invocationSource: "chat",
        threadId: chats.mainThreadId(item.companyId),
        sourceKey: INBOX_CARD_SOURCE,
        status: "done",
        resultText: line,
        hops: [],
        createdAt: at,
        updatedAt: at,
      })
      .returning({ id: tethrRouteRuns.id });
    return update(item.id, { cardRunId: run.id });
  }

  async function create(companyId: string, input: { source: "drive" | "chat" | "slack"; relPath: string; name: string; size: number }): Promise<InboxItem> {
    const [row] = await db.insert(tethrInboxItems).values({ companyId, ...input, createdAt: now(), updatedAt: now() }).returning();
    return row;
  }

  async function needsPerson(item: InboxItem, note: string): Promise<InboxItem> {
    const row = await card(await update(item.id, { status: "needs_person", note }), note);
    const { notificationService } = await import("../notify.js");
    await notificationService(db)
      .send({ companyId: item.companyId, kind: "inbox", title: `A file in tethr's Inbox needs you: ${item.name}`, href: "/drive?view=inbox" })
      .catch(logFailure("inbox bell"));
    return row;
  }

  /** Read, check, ask Jev, then suggest or act. Never throws for the file's sake: problems end on the item. */
  async function process(companyId: string, id: string): Promise<InboxItem> {
    let item = await get(companyId, id);
    const root = mirrorDir();
    if (!root) return needsPerson(item, "The shared Drive folder isn't connected, so tethr can't file it.");
    const abs = await existingFsPath(root, item.relPath);
    if (!abs) return update(item.id, { status: "failed", note: "The file isn't there any more." });
    const read = await readFileText(abs);
    const reason = needsPersonReason(`${item.name}\n${read.text ?? ""}`);
    if (reason) return needsPerson(item, `A person needs to look at this first: ${reason}. Nothing was sent to Jev.`);
    const folders = await destinationFolders(root);
    if (!folders.length) return needsPerson(item, "There are no folders in 00 Tethr to file into yet.");

    const profile = await companyProfileService(db).get(companyId);
    const recent = await db
      .select({ name: tethrInboxItems.name, filedTo: tethrInboxItems.filedTo })
      .from(tethrInboxItems)
      .where(and(eq(tethrInboxItems.companyId, companyId), eq(tethrInboxItems.status, "filed")))
      .orderBy(desc(tethrInboxItems.filedAt))
      .limit(8);
    const asks: ChoiceAsk[] = [
      { kind: "inbox.type", instructions: "What kind of document is this file?", options: choice(ITEM_TYPES, "t") },
      {
        kind: "inbox.destination",
        instructions: "Which folder should this file be filed in? Follow the filing rules first, then where similar files went.",
        options: folderOptions(companyId, folders, root),
      },
      {
        kind: "inbox.notify",
        instructions: "Who on the team should be told this file arrived? Nobody, unless it clearly concerns one person's or agent's work.",
        options: await notifyOptions(db, companyId),
      },
      { kind: "inbox.urgency", instructions: "How soon does someone need to act on this file?", options: choice(URGENCIES, "u") },
    ];
    const state = {
      file: item.name,
      text: read.text ? read.text.slice(0, JEV_TEXT_CHARS) : `(tethr can't read this kind of file; judge by its name)`,
      company: profile?.sells || profile?.name || "",
      filing_rules: activeRules(companyId).map((r) => r.text),
      recent_filings: recent.filter((r) => r.filedTo).map((r) => `${r.name} -> ${folderLabel(path.posix.dirname(r.filedTo!))}`),
    };
    const res = await decideWithJev(db, companyId, { label: item.name, subjectId: item.id, state, asks }, deps);
    if (!res.ok) {
      const why = res.reason === "off" ? "Jev filing suggestions are off." : `No suggestion: ${res.detail}`;
      return needsPerson(item, `${why} Choose where it goes.`);
    }
    const dest = res.results["inbox.destination"];
    if (!dest) return needsPerson(item, "Jev didn't suggest a folder. Choose where it goes.");
    const notify = res.results["inbox.notify"];
    const suggestion: InboxSuggestion = {
      type: res.results["inbox.type"]?.pick.label ?? "other",
      destination: dest.pick.label,
      alternatives: dest.ranked.slice(1, 3).map((o) => o.label),
      notify: notify?.pick.label ?? NOBODY,
      urgency: res.results["inbox.urgency"]?.pick.label ?? "whenever",
      confidence: dest.confidence,
      decisions: Object.fromEntries(Object.values(res.results).map((r) => [r.kind, r.decisionId])),
    };
    item = await update(item.id, { status: "suggested", suggestion, note: null });

    if (dest.mode === "auto" && dest.confident) {
      item = await fileTo(companyId, item.id, suggestion.destination, { by: "tethr (automatic)", automatic: true });
      if (notify && notify.pick.label !== NOBODY && notify.mode === "auto" && notify.confident) {
        await routeTo(companyId, item.id, notify.pick.label, { automatic: true }).catch(logFailure("inbox auto routing"));
      }
      return get(companyId, item.id);
    }
    return card(item, `Jev suggests ${suggestion.destination} (${Math.round(dest.confidence * 100)}% sure).`);
  }

  /** A file's destination, checked: one of the real folders (labels or paths). */
  async function resolveDestination(destination: string): Promise<string> {
    const root = rootOrThrow();
    const folders = await destinationFolders(root);
    const rel = folders.find((f) => f === destination || folderLabel(f) === destination);
    if (!rel) throw new InboxError("That isn't one of the folders tethr files into.");
    return rel;
  }

  async function fileTo(companyId: string, id: string, destination: string, how: { by: string; automatic?: boolean }): Promise<InboxItem> {
    const item = await get(companyId, id);
    if (item.status === "filed") throw new InboxError(`It's already filed in ${folderLabel(path.posix.dirname(item.filedTo ?? ""))}.`);
    const root = rootOrThrow();
    const rel = await resolveDestination(destination);
    if (!(await existingFsPath(root, item.relPath))) {
      await update(item.id, { status: "failed", note: "The file isn't there any more." });
      throw new InboxError("The file isn't there any more.");
    }
    const filedTo = await fsMove(root, item.relPath, rel);
    const row = await update(item.id, { status: "filed", filedTo, filedFrom: item.relPath, filedBy: how.by, filedAt: now(), relPath: filedTo });
    await inboxStore.update(companyId, (s) => {
      const folders = { ...(s.folders ?? {}) };
      const p = folders[rel] ?? { samples: [] };
      folders[rel] = { ...p, samples: [...p.samples.filter((n) => n !== item.name), item.name].slice(-SAMPLES_KEPT) };
      return { ...s, folders };
    });
    const label = folderLabel(rel);
    const decisions = item.suggestion?.decisions ?? {};
    const destDecision = decisions["inbox.destination"];
    if (destDecision) {
      if (how.automatic) await resolveDecision(db, companyId, destDecision, "automatic", { now: now() });
      else if (item.suggestion?.destination === label) await resolveDecision(db, companyId, destDecision, "accepted", { now: now() });
      else {
        await resolveDecision(db, companyId, destDecision, "corrected", { correctedTo: label, now: now() });
        await learnFromCorrection(companyId, item.suggestion?.type ?? "other", label);
      }
    }
    for (const kind of ["inbox.type", "inbox.urgency"]) {
      if (decisions[kind]) await resolveDecision(db, companyId, decisions[kind], "dropped", { now: now() }).catch(() => {});
    }
    if (decisions["inbox.notify"] && item.suggestion?.notify === NOBODY) {
      await resolveDecision(db, companyId, decisions["inbox.notify"], "accepted", { now: now() }).catch(() => {});
    }
    return card(row, `Filed in ${label} by ${how.by}.`);
  }

  /** Two corrections of the same kind to the same folder: propose a rule. */
  async function learnFromCorrection(companyId: string, type: string, destination: string): Promise<FilingRule | null> {
    const at = now();
    let proposed: FilingRule | null = null;
    await inboxStore.update(companyId, (s) => {
      const since = at.getTime() - 60 * DAY;
      const corrections = [...(s.corrections ?? []), { type, destination, at: at.toISOString() }].filter((c) => Date.parse(c.at) >= since).slice(-100);
      const same = corrections.filter((c) => c.type === type && c.destination === destination).length;
      const known = (s.rules ?? []).some((r) => r.type === type && r.destination === destination);
      if (same >= 2 && !known) {
        const noun = type === "other" ? "Other files" : `${type[0].toUpperCase()}${type.slice(1)}${type.endsWith("s") || type.endsWith("material") || type.endsWith("research") ? "" : "s"}`;
        proposed = { id: randomUUID(), text: `${noun} go to ${destination}`, type, destination, status: "proposed", at: at.toISOString() };
        return { ...s, corrections, rules: [...(s.rules ?? []), proposed] };
      }
      return { ...s, corrections };
    });
    if (proposed) {
      const { notificationService } = await import("../notify.js");
      await notificationService(db)
        .send({ companyId, kind: "inbox", title: `tethr suggests a filing rule: ${(proposed as FilingRule).text}`, href: "/drive?view=inbox" })
        .catch(logFailure("inbox rule bell"));
    }
    return proposed;
  }

  /** Tell a person, or hand an agent a task, about a filed (or waiting) file. */
  async function routeTo(companyId: string, id: string, who: string, how: { automatic?: boolean; userId?: string | null }): Promise<InboxItem> {
    const item = await get(companyId, id);
    const where = item.status === "filed" ? `filed in ${folderLabel(path.posix.dirname(item.filedTo ?? ""))}` : `waiting in tethr's Inbox`;
    const decision = item.suggestion?.decisions?.["inbox.notify"];
    if (who.startsWith("@")) {
      const team = teamService(db);
      const router = await import("../org.js").then((m) => m.orgService(db).getRouterProfile(companyId));
      await team.assign(
        companyId,
        who,
        {
          title: `Look at the file "${item.name}"`,
          brief: `A file came into tethr's Inbox and is ${where}: ${item.relPath} in the shared 00 Tethr folder. Open it with Read, see what it means for your work, and say in your report what you did or what should happen.`,
        },
        how.userId ? { userId: how.userId } : { agentId: router?.agent.id ?? null },
      );
    } else if (who !== NOBODY) {
      await tell(db, companyId, who, `"${item.name}" came into tethr's Inbox and is ${where}.`);
    }
    if (decision) {
      const outcome = how.automatic ? "automatic" : item.suggestion?.notify === who ? "accepted" : "corrected";
      await resolveDecision(db, companyId, decision, outcome, { correctedTo: who, now: now() }).catch(() => {});
    }
    return update(item.id, { note: who === NOBODY ? item.note : `${who.startsWith("@") ? "Handed to" : "Told"} ${who}.` });
  }

  async function leave(companyId: string, id: string): Promise<InboxItem> {
    const item = await get(companyId, id);
    for (const decision of Object.values(item.suggestion?.decisions ?? {})) {
      await resolveDecision(db, companyId, decision, "dropped", { now: now() }).catch(() => {});
    }
    return card(await update(item.id, { status: "left" }), "Left where it is.");
  }

  /** "Put it back" (within 7 days): the file goes back to the Inbox to be filed again. */
  async function putBack(companyId: string, id: string): Promise<InboxItem> {
    const item = await get(companyId, id);
    if (item.status !== "filed" || !item.filedTo || !item.filedAt) throw new InboxError("Only a filed item can be put back.");
    if (now().getTime() - item.filedAt.getTime() > UNDO_DAYS * DAY) throw new InboxError(`It was filed more than ${UNDO_DAYS} days ago; move it in the Drive instead.`);
    const root = rootOrThrow();
    const back = await fsMove(root, item.filedTo, INBOX_DIR);
    const decision = item.suggestion?.decisions?.["inbox.destination"];
    if (decision && item.filedBy?.includes("automatic")) {
      await resolveDecision(db, companyId, decision, "undone", { now: now(), onDemoted: (kind) => announceDemotion(companyId, kind) });
    }
    return card(await update(item.id, { status: "suggested", relPath: back, filedTo: null, filedBy: null, filedAt: null, filedFrom: null }), "Put back in the Inbox.");
  }

  async function announceDemotion(companyId: string, kind: string): Promise<void> {
    const { notificationService } = await import("../notify.js");
    await notificationService(db)
      .send({ companyId, kind: "decision", title: `Back to suggestions: two of tethr's automatic decisions (${kind}) were undone this week.`, href: "/tethr-settings" })
      .catch(logFailure("demotion bell"));
  }

  /** "File this": copy a chat upload (or a Slack file) into the Inbox and take it. */
  async function takeWorkspaceFile(companyId: string, abs: string, source: "chat" | "slack"): Promise<InboxItem> {
    const root = rootOrThrow();
    const name = path.basename(abs);
    const saved = await writeNewFile(path.join(root, INBOX_DIR), name, await fsp.readFile(abs));
    const rel = `${INBOX_DIR}/${saved}`;
    const stat = await fsp.stat(path.join(root, rel));
    const item = await create(companyId, { source, relPath: rel, name: saved, size: stat.size });
    return process(companyId, item.id);
  }

  /**
   * Look at the Drive's 00 Inbox: a file that hasn't changed for 30 seconds is
   * taken (the folder is made if it's missing). Returns the items it took.
   */
  async function scan(companyId: string): Promise<InboxItem[]> {
    const root = mirrorDir();
    if (!root) return [];
    const dir = path.join(root, INBOX_DIR);
    await fsp.mkdir(dir, { recursive: true });
    const entries = (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && !e.name.startsWith(".") && !e.name.startsWith("~$"));
    const open = await db
      .select({ relPath: tethrInboxItems.relPath })
      .from(tethrInboxItems)
      .where(and(eq(tethrInboxItems.companyId, companyId), inArray(tethrInboxItems.status, ["new", "needs_person", "suggested", "left", "failed"])));
    const taken = new Set(open.map((o) => o.relPath));
    const t = now().getTime();
    const ready: Array<{ rel: string; size: number }> = [];
    await inboxStore.update(companyId, (s) => {
      const watching: NonNullable<typeof s.watching> = {};
      for (const e of entries) {
        const rel = `${INBOX_DIR}/${e.name}`;
        if (taken.has(rel)) continue;
        let stat: fs.Stats;
        try {
          stat = fs.statSync(path.join(dir, e.name));
        } catch {
          continue;
        }
        const was = s.watching?.[rel];
        const same = was && was.size === stat.size && was.mtimeMs === stat.mtimeMs;
        const since = same ? was.since : t;
        if (same && t - since >= STABLE_MS && t - stat.mtimeMs >= STABLE_MS) ready.push({ rel, size: stat.size });
        else watching[rel] = { size: stat.size, mtimeMs: stat.mtimeMs, since };
      }
      return { ...s, watching };
    });
    const out: InboxItem[] = [];
    for (const r of ready) {
      const item = await create(companyId, { source: "drive", relPath: r.rel, name: path.posix.basename(r.rel), size: r.size });
      out.push(await process(companyId, item.id).catch(async (err) => update(item.id, { status: "failed", note: err instanceof Error ? err.message : String(err) })));
    }
    return out;
  }

  async function list(companyId: string): Promise<{ open: InboxItem[]; filed: InboxItem[] }> {
    const recent = new Date(now().getTime() - 30 * DAY);
    const open = await db
      .select()
      .from(tethrInboxItems)
      .where(and(eq(tethrInboxItems.companyId, companyId), inArray(tethrInboxItems.status, ["new", "needs_person", "suggested"])))
      .orderBy(desc(tethrInboxItems.createdAt))
      .limit(100);
    const filed = await db
      .select()
      .from(tethrInboxItems)
      .where(and(eq(tethrInboxItems.companyId, companyId), inArray(tethrInboxItems.status, ["filed", "left", "failed"]), gte(tethrInboxItems.updatedAt, recent)))
      .orderBy(desc(tethrInboxItems.updatedAt))
      .limit(50);
    return { open, filed };
  }

  /** A person accepts or turns down a proposed rule. An active rule goes to Jev with every filing decision. */
  async function decideRule(companyId: string, ruleId: string, accept: boolean): Promise<FilingRule[]> {
    const next = await inboxStore.update(companyId, (s) => ({
      ...s,
      rules: (s.rules ?? []).map((r) => (r.id === ruleId ? { ...r, status: accept ? "active" : "rejected" } : r)),
    }));
    if (accept) await mirrorRulesToHermes(companyId).catch(logFailure("filing rules skill"));
    return next.rules ?? [];
  }

  return { get, create, process, fileTo, routeTo, leave, putBack, takeWorkspaceFile, scan, list, decideRule, resolveDestination, learnFromCorrection };
}

/** With Hermes on, the active rules are also a skill, "filing-rules", that tethr can load. */
async function mirrorRulesToHermes(companyId: string): Promise<void> {
  const { memoryBackend, saveSkill } = await import("../hermes/memory-layer.js");
  if (memoryBackend(companyId) !== "hermes") return;
  const rules = activeRules(companyId);
  if (!rules.length) return;
  await saveSkill(companyId, {
    name: "filing-rules",
    description: "Where files go: the rules the team agreed",
    body: ["# Filing rules", "", "Agreed by the team; tethr's Inbox gives them to Jev with every filing decision.", "", ...rules.map((r) => `- ${r.text}`)].join("\n"),
  });
}

/** Look at every company's Inbox once a minute (never under tests). */
export function startInboxWatcher(db: Db): void {
  if (process.env.VITEST || process.env.NODE_ENV === "test") return;
  let busy = false;
  const tick = async () => {
    if (busy || !mirrorDir()) return;
    busy = true;
    try {
      const { resolveTethrCompanyId } = await import("../slack.js");
      const companyId = await resolveTethrCompanyId(db);
      if (companyId) await inboxService(db).scan(companyId);
    } catch (err) {
      logFailure("scanning tethr's Inbox")(err);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), 60_000);
  timer.unref?.();
}
