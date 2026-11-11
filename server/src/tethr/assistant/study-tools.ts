import { oneLine } from "../goals.js";
import { AREA_IDS, isAreaId } from "../growth-map/areas.js";
import { SKILL_DESCRIPTION_MAX, SKILL_NAME_RE, viewSkill } from "../hermes/memory-layer.js";
import { learningStore } from "../learn/store.js";
import { FINDING_EVIDENCE, FINDING_STRENGTHS, getStudy, updateStudy, VERDICTS, type Finding, type Study, type Verdict } from "../learn/studies.js";
import {
  crossingRefusal,
  finishStudy,
  foreignLinks,
  recordSkillChange,
  REVIEW_SKILLS,
  SKILL_BODY,
  SKILLS_PER_STUDY,
  startStudy,
  StudyError,
} from "../learn/study.js";
import { injectionReason, medicalClaimReason, needsPersonReason } from "../screen.js";
import { teamService } from "../team.js";
import type { SandboxRoom } from "./sandbox.js";
import type { McpToolDef, TethrToolContext, TethrToolResult } from "./tethr-tools.js";

// The learner's study tools (2026-11-10), one set per room (sandbox.ts). Nobody
// else lists or runs them. Each checks it's in its room and its study's step:
// - desk: start_study (someone in Sage's chat asks it to learn something)
// - plan: plan_study / skip_study
// - research: submit_findings
// - apply: apply_skill / finish_study

const LIMITS = { topic: 160, why: 600, question: 220, baseline: 2000, claim: 300, detail: 1200, appliesWhen: 300, counterpoint: 400, summary: 1200, whatChanged: 300, verdictNote: 300 } as const;

export const STUDY_TOOL_DEFS: McpToolDef[] = [
  {
    name: "start_study",
    description: "Start studying a topic someone asked you to learn (it runs in the background: plan, research on the web, then compare with what tethr knows and save skills). `depth`: deep (default, a long thorough study) or quick.",
    inputSchema: { type: "object", properties: { topic: { type: "string" }, depth: { type: "string", enum: ["deep", "quick"] } }, required: ["topic"] },
  },
  {
    name: "review_skills",
    description: "Review tethr's skills: check each holds as the company grows (from a small test to many times the budget) and rewrite the narrow ones as foundations. Runs in the background; no web.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "plan_study",
    description: "Your plan for this study. The researcher on the web sees ONLY topic and questions, so keep those general (no names, emails, figures or internal details). The baseline stays private.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string" },
        why: { type: "string" },
        area: { type: "string", enum: [...AREA_IDS, "general"] },
        questions: { type: "array", minItems: 3, maxItems: 8, items: { type: "string" } },
        baseline: { type: "string" },
        depth: { type: "string", enum: ["quick", "deep"] },
      },
      required: ["topic", "why", "area", "questions", "baseline"],
    },
  },
  {
    name: "skip_study",
    description: "Nothing is worth studying right now: say what you looked at and why nothing stood out.",
    inputSchema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
  },
  {
    name: "submit_findings",
    description: "Hand in your research once: up to 12 findings and a 2-4 sentence summary.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        findings: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: {
            type: "object",
            properties: {
              claim: { type: "string" },
              detail: { type: "string" },
              evidence: { type: "string", enum: [...FINDING_EVIDENCE] },
              strength: { type: "string", enum: [...FINDING_STRENGTHS] },
              sources: {
                type: "array",
                minItems: 1,
                maxItems: 4,
                items: { type: "object", properties: { url: { type: "string" }, title: { type: "string" } }, required: ["url", "title"] },
              },
              applies_when: { type: "string" },
              counterpoint: { type: "string" },
            },
            required: ["claim", "detail", "evidence", "strength", "sources"],
          },
        },
      },
      required: ["summary", "findings"],
    },
  },
  {
    name: "apply_skill",
    description: `Save one skill from this study (at most ${SKILLS_PER_STUDY}): a procedure tethr follows for a kind of job. \`name\` (lowercase-with-dashes; a skill you made before to improve it), \`description\` (one line, at most ${SKILL_DESCRIPTION_MAX} characters), \`area\`, \`body\` (Markdown: when to use it, steps, numbers to aim for, pitfalls, how to tell it's working, sources), \`what_changed\` (one line).`,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        area: { type: "string", enum: [...AREA_IDS] },
        body: { type: "string" },
        what_changed: { type: "string" },
      },
      required: ["name", "description", "area", "body", "what_changed"],
    },
  },
  {
    name: "finish_study",
    description: "Close the study: a summary in 2 or 3 short sentences, under 70 words (what you learned, what changed, what tethr does differently now), and a verdict for every finding (by its number).",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        verdicts: {
          type: "array",
          items: {
            type: "object",
            properties: { finding: { type: "number" }, verdict: { type: "string", enum: [...VERDICTS] }, note: { type: "string" } },
            required: ["finding", "verdict", "note"],
          },
        },
      },
      required: ["summary", "verdicts"],
    },
  },
];

const ROOM_OF: Record<string, SandboxRoom> = {
  start_study: "desk",
  review_skills: "desk",
  plan_study: "plan",
  skip_study: "plan",
  submit_findings: "research",
  apply_skill: "apply",
  finish_study: "apply",
};
const STEP_OF: Partial<Record<string, Study["status"]>> = {
  plan_study: "planning",
  skip_study: "planning",
  submit_findings: "researching",
  apply_skill: "applying",
  finish_study: "applying",
};

const err = (name: string, text: string): TethrToolResult => ({ text: `${name}: ${text}`, isError: true });
/** Prose cut to `max` at the last whole sentence (a summary never ends mid-sentence). */
export function wholeSentences(v: unknown, max: number): string {
  const text = typeof v === "string" ? v.trim() : "";
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return end > max / 3 ? cut.slice(0, end + 1) : `${cut.slice(0, max - 1).trimEnd()}…`;
}
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const httpsUrl = (v: unknown) => {
  try {
    const u = new URL(String(v));
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
};

/** Why a skill can't be saved, or null. Checked when it's saved and again when a card is approved. */
export function skillRefusal(k: { name: string; description: string; area: string; body: string }, study: Pick<Study, "findings">, previousBody = ""): string | null {
  if (!SKILL_NAME_RE.test(k.name)) return "name: lowercase letters, digits, dots, dashes or underscores (up to 64).";
  if (!k.description || k.description.length > SKILL_DESCRIPTION_MAX || /\n/.test(k.description)) return `description: one line of at most ${SKILL_DESCRIPTION_MAX} characters.`;
  if (!isAreaId(k.area)) return `area must be one of ${AREA_IDS.join(", ")}.`;
  if (k.body.length < SKILL_BODY.min || k.body.length > SKILL_BODY.max) return `the body should be ${SKILL_BODY.min} to ${SKILL_BODY.max} characters.`;
  const text = `${k.description}\n${k.body}`;
  const screened = injectionReason(text) ?? needsPersonReason(text) ?? medicalClaimReason(text);
  if (screened) return screened;
  // A skill tells tethr how to work; an address in one is how a web page would try to send data out.
  if (/[\w.+-]+@[\w-]+(\.[\w-]+)+/.test(text)) return "a skill can't hold an email address.";
  const foreign = foreignLinks(k.body, study, previousBody);
  if (foreign.length) return `links must be the study's own sources; not ${foreign.slice(0, 2).join(", ")}.`;
  return null;
}

export async function runStudyTool(name: string, a: Record<string, unknown>, ctx: TethrToolContext): Promise<TethrToolResult> {
  if (!ctx.db || !ctx.companyId) return err(name, "studies aren't available here.");
  if (ctx.room !== ROOM_OF[name]) return err(name, `only in Sage's ${ROOM_OF[name] ?? "study"} room.`);
  const { db, companyId } = ctx;
  try {
    if (name === "start_study") {
      const depth = a.depth === "quick" ? "quick" : "deep";
      const study = await startStudy(db, companyId, { trigger: "asked", topic: str(a.topic, 200), depth, by: "you" });
      return { text: `Started a ${depth} study of "${study.asked}". Its card in this chat shows how it goes; what it learns becomes skills tethr uses.`, meta: { studyId: study.id } };
    }
    if (name === "review_skills") {
      const review = await startStudy(db, companyId, { trigger: "asked", kind: "review", by: "you" });
      return { text: "Started reviewing tethr's skills. Its card in this chat shows how it goes.", meta: { studyId: review.id } };
    }
    const study = ctx.studyId ? getStudy(companyId, ctx.studyId) : null;
    if (!study) return err(name, "this turn isn't part of a study.");
    if (study.status !== STEP_OF[name]) return err(name, `the study is ${study.status}, not at this step.`);

    if (name === "plan_study") {
      const topic = oneLine(a.topic, LIMITS.topic);
      const questions = (Array.isArray(a.questions) ? a.questions : []).map((q) => oneLine(q, LIMITS.question)).filter((q) => q.length >= 10);
      if (topic.length < 5) return err(name, "give a topic.");
      if (questions.length < 3 || questions.length > 8) return err(name, "give 3 to 8 questions of at least 10 characters.");
      for (const text of [topic, ...questions]) {
        const refused = crossingRefusal(text);
        if (refused) return err(name, `"${text.slice(0, 80)}" can't go to the web: ${refused}. Say it in general terms (the baseline is where company details belong).`);
      }
      const area = isAreaId(a.area) ? a.area : null;
      const depth = study.trigger === "asked" ? study.depth : a.depth === "deep" && (await deepOk(companyId)) ? "deep" : "quick";
      await updateStudy(companyId, study.id, (s) => ({
        ...s,
        topic,
        why: wholeSentences(a.why, LIMITS.why) || null,
        area,
        questions,
        baseline: str(a.baseline, LIMITS.baseline) || null,
        depth,
      }));
      return { text: `Planned a ${depth} study of "${topic}". The research starts after this turn; you're done here.` };
    }

    if (name === "skip_study") {
      await finishStudy(db, companyId, study.id, "nothing", str(a.reason, LIMITS.why) || "Nothing stood out.");
      return { text: "Noted: nothing to study this time. You're done here." };
    }

    if (name === "submit_findings") {
      const findings: Finding[] = [];
      for (const raw of (Array.isArray(a.findings) ? a.findings : []).slice(0, 12)) {
        const f = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
        const sources = (Array.isArray(f.sources) ? f.sources : [])
          .map((s) => (s && typeof s === "object" ? (s as Record<string, unknown>) : {}))
          .map((s) => ({ url: httpsUrl(s.url), title: oneLine(s.title, 160) }))
          .filter((s): s is { url: string; title: string } => !!s.url)
          .slice(0, 4);
        const claim = oneLine(f.claim, LIMITS.claim);
        const detail = str(f.detail, LIMITS.detail);
        if (claim.length < 10 || !sources.length) continue;
        // A finding about a particular person, or carrying a key, isn't kept.
        if (needsPersonReason(`${claim}\n${detail}`)) continue;
        findings.push({
          claim,
          detail,
          evidence: (FINDING_EVIDENCE as readonly string[]).includes(String(f.evidence)) ? (f.evidence as Finding["evidence"]) : "anecdote",
          strength: (FINDING_STRENGTHS as readonly string[]).includes(String(f.strength)) ? (f.strength as Finding["strength"]) : "weak",
          sources: sources.map((s) => ({ url: s.url, title: s.title || new URL(s.url).hostname })),
          appliesWhen: str(f.applies_when, LIMITS.appliesWhen) || null,
          counterpoint: str(f.counterpoint, LIMITS.counterpoint) || null,
        });
      }
      if (!findings.length) return err(name, "no finding was usable: each needs a claim and at least one https source.");
      await updateStudy(companyId, study.id, (s) => ({ ...s, findings, researchSummary: wholeSentences(a.summary, LIMITS.summary) || null }));
      const sources = new Set(findings.flatMap((f) => f.sources.map((s) => s.url))).size;
      return { text: `Saved ${findings.length} findings from ${sources} sources. You're done here.` };
    }

    if (name === "apply_skill") {
      const k = { name: str(a.name, 64), description: oneLine(a.description, 200), area: String(a.area ?? ""), body: str(a.body, SKILL_BODY.max + 1) };
      // Rewriting a skill may keep the links it already had.
      const existing = await viewSkill(companyId, k.name).catch(() => null);
      const refused = skillRefusal(k, study, existing?.content ?? "");
      if (refused) return err(name, refused);
      const cap = study.kind === "review" ? REVIEW_SKILLS : SKILLS_PER_STUDY;
      const others = study.skills.filter((x) => x.name !== k.name && x.status !== "refused");
      if (others.length >= cap) return err(name, `at most ${cap} skills per ${study.kind === "review" ? "review" : "study"}.`);
      const member = ctx.threadId ? await teamService(db).byThread(companyId, ctx.threadId) : null;
      if (!member?.sandbox) return err(name, "only Sage saves skills from a study.");
      const record = await recordSkillChange(db, companyId, study, { ...k, whatChanged: oneLine(a.what_changed, LIMITS.whatChanged) }, {
        applyMode: learningStore.get(companyId).applyMode ?? "auto",
        agent: member,
      });
      return {
        text:
          record.status === "pending"
            ? `${record.name} goes to a person as a card first (${record.change === "new" ? "new" : "a change to a skill"}).`
            : `Saved ${record.change === "new" ? "the new skill" : "the update to"} ${record.name}. tethr lists it from its next turn.`,
        meta: { skill: record.name, status: record.status },
      };
    }

    if (name === "finish_study") {
      const summary = wholeSentences(a.summary, LIMITS.summary);
      if (summary.length < 20) return err(name, "give a 2-4 sentence summary.");
      const verdicts: Verdict[] = (Array.isArray(a.verdicts) ? a.verdicts : [])
        .map((v) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {}))
        .map((v) => ({ finding: Math.round(Number(v.finding)), verdict: v.verdict as Verdict["verdict"], note: oneLine(v.note, LIMITS.verdictNote) }))
        .filter((v) => v.finding >= 1 && v.finding <= study.findings.length && (VERDICTS as readonly string[]).includes(v.verdict));
      await updateStudy(companyId, study.id, (s) => ({ ...s, summary, verdicts }));
      return { text: "Study closed. You're done here." };
    }
    return err(name, "unknown study tool.");
  } catch (e) {
    if (e instanceof StudyError) return err(name, e.message);
    throw e;
  }
}

async function deepOk(companyId: string): Promise<boolean> {
  const { paceSchedule } = await import("../learn/learning-pace.js");
  const { studiesSince } = await import("../learn/studies.js");
  const rule = paceSchedule(learningStore.get(companyId).pace).deep;
  if (rule === "always" || rule === "big_gap") return true;
  if (rule === "never") return false;
  return !studiesSince(companyId, new Date(Date.now() - 7 * 86_400_000)).some((s) => s.depth === "deep" && s.trigger === "observed");
}
