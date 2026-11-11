import path from "node:path";
import type { Db } from "@paperclipai/db";
import { assistantHome } from "../assistant/workspace.js";
import { agentThreadId, teamConnectorLabels, teamService, type TeamAgent } from "../team.js";
import { validateTeamSpec } from "../team-spec.js";
import { paceSchedule, STUDY_CEILING, type LearningPace } from "./learning-pace.js";
import { learningStore } from "./store.js";

// The learner (phase 26.6, rebuilt 2026-11-10): a ready-made agent on tethr's
// team, working name @sage. It watches how tethr is doing at the pace a person
// sets, studies what would help (or what someone asks it to learn), compares what
// it found with what tethr already knows, and saves the result as skills tethr
// and its agents load before that kind of work. A study runs in sealed rooms
// (assistant/sandbox.ts, learn/study.ts): private data and the web are never in
// the same room. It exists only once a person switches it on, and has a budget
// like every agent.

export const LEARNER_TAG = "@sage";

const LEARNER_INSTRUCTIONS =
  "You are Sage, the learner. You watch how tethr is doing, study what would help, and turn what you learn into skills tethr and its agents use. When someone asks you to learn something, call start_study with the topic. Studies run in sealed rooms; your chat with people has no web. Never a medical claim, never a person's details.";
const MISSION = "Watches how tethr is doing, studies what would help, and turns what it learns into skills tethr and its agents use.";
const BRIEF = "Watch how tethr is doing and study what would help.";

export class LearnerError extends Error {}

/**
 * The learner's tag when `threadId` is its chat, whether or not its agent still
 * exists. The gate, the runner and the tools endpoint use it so a learner
 * whose agent was deleted can't run with tethr's rights.
 */
export function sealedThreadTag(companyId: string, threadId: string): string | null {
  const tag = learningStore.get(companyId).agentTag;
  return tag && agentThreadId(companyId, tag) === threadId ? tag : null;
}

/** The learner's sealed folders (instance dir, never the shared Drive); one per room (learn/rooms.ts). */
export function sandboxDir(tag: string): string {
  return path.join(assistantHome(), "sandbox", tag.replace(/^@/, ""));
}

function template(companyId: string) {
  return {
    name: "Sage",
    tag: LEARNER_TAG.slice(1),
    title: "Learner",
    mission: MISSION,
    instructions: LEARNER_INSTRUCTIONS,
    connectors: ["Tethr tools"],
    schedule: { cron: paceSchedule(learningStore.get(companyId).pace).cron, brief: BRIEF },
    budget_usd: 10,
    max_runs_per_day: STUDY_CEILING,
    owner: "growth",
  };
}

/** Switch the learner on: made the first time (paused agents are resumed), never before a person asks. */
export async function enableLearner(db: Db, companyId: string, actor: { userId: string | null }): Promise<TeamAgent> {
  const team = teamService(db);
  const state = learningStore.get(companyId);
  let agent = state.agentTag ? await team.get(companyId, state.agentTag) : null;
  if (agent && !agent.sandbox) throw new LearnerError(`${agent.tag} isn't the learner; rename that agent first.`);
  if (!agent) {
    const spec = validateTeamSpec(template(companyId), { takenTags: await team.takenTags(companyId), connectors: teamConnectorLabels(companyId) });
    agent = await team.create(companyId, spec, { userId: actor.userId, via: "approval" }, { sandbox: true });
  } else if (agent.paused) {
    agent = await team.setPaused(companyId, agent.tag, false, { userId: actor.userId });
  }
  await learningStore.update(companyId, (s) => ({ ...s, enabled: true, agentTag: agent!.tag }));
  return agent;
}

export async function disableLearner(db: Db, companyId: string, actor: { userId: string | null }): Promise<void> {
  const state = learningStore.get(companyId);
  if (state.agentTag) {
    const agent = await teamService(db).get(companyId, state.agentTag);
    if (agent && !agent.paused) await teamService(db).setPaused(companyId, agent.tag, true, { userId: actor.userId });
  }
  await learningStore.update(companyId, (s) => ({ ...s, enabled: false }));
}

/** The learner, when it's switched on and not paused (null otherwise). */
export async function activeLearner(db: Db, companyId: string): Promise<TeamAgent | null> {
  const state = learningStore.get(companyId);
  if (!state.enabled || !state.agentTag) return null;
  const agent = await teamService(db).get(companyId, state.agentTag).catch(() => null);
  return agent?.sandbox && !agent.paused ? agent : null;
}

/** Apply a learning pace: saved, and the learner's routine follows it (when the learner exists). */
export async function setLearningPace(db: Db, companyId: string, pace: LearningPace, actor: { userId: string | null }): Promise<LearningPace> {
  await learningStore.update(companyId, (s) => ({ ...s, pace }));
  const tag = learningStore.get(companyId).agentTag;
  const agent = tag ? await teamService(db).get(companyId, tag) : null;
  if (agent?.sandbox) await teamService(db).update(companyId, agent.tag, { schedule: { cron: paceSchedule(pace).cron, brief: BRIEF } }, actor);
  return pace;
}

/**
 * Boot: a learner made before the rebuild gets the new mission, instructions,
 * schedule (from its pace, Steady by default) and ceiling. It never switches the
 * learner on and never runs it.
 */
export async function healLearner(db: Db): Promise<number> {
  const { companies } = await import("@paperclipai/db");
  const rows = await db.select({ id: companies.id }).from(companies);
  let healed = 0;
  for (const { id: companyId } of rows) {
    const tag = learningStore.get(companyId).agentTag;
    const agent = tag ? await teamService(db).get(companyId, tag).catch(() => null) : null;
    if (!agent?.sandbox || agent.instructions === LEARNER_INSTRUCTIONS) continue;
    await teamService(db).update(
      companyId,
      agent.tag,
      {
        mission: MISSION,
        instructions: LEARNER_INSTRUCTIONS,
        maxRunsPerDay: STUDY_CEILING,
        ...(agent.schedule ? { schedule: { cron: paceSchedule(learningStore.get(companyId).pace).cron, brief: BRIEF } } : {}),
      },
      { userId: null },
    );
    healed += 1;
  }
  return healed;
}
