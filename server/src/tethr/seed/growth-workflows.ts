import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, routines, tethrAgentProfiles } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { routineService } from "../../services/routines.js";
import { CEO_AGENT } from "./ceo.js";

// Phase 16 — the growth operating loop. Tethr's job right now is acquiring
// customers; these are its recurring growth workflows. Each is a core routine
// whose description IS the playbook: when it fires, core opens a task with
// that brief and wakes the owner, who works it in task mode (and may delegate).
// All seeded PAUSED with their schedule trigger DISABLED — Mark switches each
// one on (hard gate: no autonomous runs without an explicit go).

export interface GrowthWorkflow {
  key: string;
  title: string;
  ownerTag: string;
  cron: string;
  cadence: string;
  description: string;
}

export const GROWTH_WORKFLOWS: GrowthWorkflow[] = [
  {
    key: "weekly-growth-plan",
    title: "Weekly growth plan",
    ownerTag: "@ceo",
    cron: "41 8 * * 1",
    cadence: "Mondays 8:41 AM ET",
    description: [
      "Goal: more customers this week.",
      "1. Read what shipped last week (the Drive, Queue decisions, memory).",
      "2. Pick the 3 highest-leverage customer-acquisition moves for this week — SEO and AI search, seasonal campaigns, partnerships, paid.",
      "3. Delegate each separable move as one task with delegate_task to the right specialist (@rank for keyword briefs, @tank for AI-search audits). Do the rest yourself.",
      "4. If a move needs a capability no agent has (e.g. partnerships outreach), propose that agent with propose_agent instead of faking the work.",
      "Deliver: the weekly growth plan — the 3 moves, who owns each, and what done looks like.",
    ].join("\n"),
  },
  {
    key: "content-engine",
    title: "SEO + AI-search content engine",
    ownerTag: "@ceo",
    cron: "17 9 * * 2",
    cadence: "Tuesdays 9:17 AM ET",
    description: [
      "Ship one customer-acquisition content piece a week.",
      "Delegate the keyword brief for the highest-intent travel-health topic we haven't covered — one that routes to a real Wandr product — to @rank.",
      "Delegate an AI-search (GEO) audit of the page that topic should land on to @tank.",
      "When both are back, roll up into a writer-ready brief: target terms, the page, an outline, and the fixes that make the page citable by AI answer engines.",
      "Publishing stays human-approved.",
    ].join("\n"),
  },
  {
    key: "seasonal-demand",
    title: "Seasonal demand scan",
    ownerTag: "@rank",
    cron: "23 9 1 * *",
    cadence: "1st of each month, 9:23 AM ET",
    description: [
      "Look 6–10 weeks ahead: which travel seasons and destinations drive travel-health demand next (spring break, summer, holidays, festivals)?",
      "Use keyword_ideas for seasonal search volume and web_fetch for current travel notices.",
      "Deliver a seasonal campaign brief: the top 3 moments, target search terms with volume, the Wandr product each routes to, and suggested content or ads.",
    ].join("\n"),
  },
  {
    key: "weekly-growth-review",
    title: "Weekly growth review",
    ownerTag: "@tethr",
    cron: "37 15 * * 5",
    cadence: "Fridays 3:37 PM ET",
    description: [
      "Summarize the growth week for Mark on one screen:",
      "what shipped (published outputs), what's waiting on Mark in the Queue, which tasks are blocked and why, and spend against each agent's cap.",
      "End with the 3 decisions Mark should make next week.",
    ].join("\n"),
  },
];

/** The CEO's growth framing (applied only over the untouched seeded defaults). */
export const CEO_GROWTH_TITLE = "Head of growth — runs the agent org";
export const CEO_GROWTH_MISSION =
  "Acquire customers for Wandr Health. Set the weekly growth plan, delegate the work to specialists as tracked tasks, review what comes back, and write the roll-ups. Never publish or spend past the human approval and budget gates.";

async function agentIdForTag(db: Db, companyId: string, tag: string): Promise<string | null> {
  const [row] = await db
    .select({ agentId: tethrAgentProfiles.agentId })
    .from(tethrAgentProfiles)
    .where(and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, tag)))
    .limit(1);
  return row?.agentId ?? null;
}

/** Reframe the CEO as head of growth — only where it still has the seeded defaults. */
async function reframeCeoForGrowth(db: Db, companyId: string): Promise<boolean> {
  const ceoId = await agentIdForTag(db, companyId, "@ceo");
  if (!ceoId) return false;
  let changed = false;
  const [agent] = await db.select({ title: agents.title }).from(agents).where(eq(agents.id, ceoId)).limit(1);
  if (agent && (agent.title === CEO_AGENT.title || !agent.title)) {
    await db.update(agents).set({ title: CEO_GROWTH_TITLE, updatedAt: new Date() }).where(eq(agents.id, ceoId));
    changed = true;
  }
  const [profile] = await db
    .select({ id: tethrAgentProfiles.id, mission: tethrAgentProfiles.mission })
    .from(tethrAgentProfiles)
    .where(and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, "@ceo")))
    .limit(1);
  if (profile && (profile.mission === CEO_AGENT.mission || !profile.mission)) {
    await db
      .update(tethrAgentProfiles)
      .set({ mission: CEO_GROWTH_MISSION, updatedAt: new Date() })
      .where(eq(tethrAgentProfiles.id, profile.id));
    changed = true;
  }
  return changed;
}

/**
 * Seed the growth workflows (paused) and the CEO's growth framing. Idempotent:
 * a workflow is matched by its title on the owner agent; missing owners are
 * skipped (seed the agent first). Never re-enables or edits an existing one.
 */
export async function seedGrowthWorkflows(
  db: Db,
  companyId: string,
): Promise<{ created: string[]; skipped: string[]; ceoReframed: boolean }> {
  const created: string[] = [];
  const skipped: string[] = [];
  const svc = routineService(db);
  for (const wf of GROWTH_WORKFLOWS) {
    const ownerId = await agentIdForTag(db, companyId, wf.ownerTag);
    if (!ownerId) {
      skipped.push(wf.key);
      continue;
    }
    const [existing] = await db
      .select({ id: routines.id })
      .from(routines)
      .where(and(eq(routines.companyId, companyId), eq(routines.title, wf.title)))
      .limit(1);
    if (existing) continue;
    const routine = await svc.create(
      companyId,
      {
        title: wf.title,
        description: wf.description,
        assigneeAgentId: ownerId,
        priority: "high",
        status: "paused",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [],
      },
      { userId: "tethr-seed" },
    );
    await svc.createTrigger(
      routine.id,
      {
        kind: "schedule",
        cronExpression: wf.cron,
        timezone: "America/New_York",
        enabled: false,
        label: wf.cadence,
      } as never,
      { userId: "tethr-seed" },
    );
    created.push(wf.key);
  }
  const ceoReframed = await reframeCeoForGrowth(db, companyId);
  if (created.length || ceoReframed) {
    logger.info({ companyId, created, ceoReframed }, "[tethr] growth workflows seeded (paused)");
  }
  return { created, skipped, ceoReframed };
}
