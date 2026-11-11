import { and, desc, eq, inArray, lte, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tethrDecisions, tethrLessons, tethrRouteRuns, type LessonSource } from "@paperclipai/db";
import * as chats from "../chats.js";
import { companyProfileService } from "../company.js";
import { resolveDecision, scoreWithJev, type DecideDeps } from "../decide/decide.js";
import { oneLine } from "../goals.js";
import { areaById, isAreaId } from "../growth-map/areas.js";
import { setSkillArea } from "../growth-map/store.js";
import { deleteSkill, memoryBackend, saveSkill, SKILL_DESCRIPTION_MAX } from "../hermes/memory-layer.js";
import { canSpend, getPace, spend, updatePace } from "../pace.js";
import { injectionReason, medicalClaimReason, needsPersonReason } from "../screen.js";
import { getSetup } from "../setup.js";
import { DAY } from "../time.js";
import { domainOf, scoreSources, trustedSources } from "./store.js";

// What tethr learned (phase 26.5): one record for lessons from the team (a
// correction in chat, with an OK), from results (the Friday review), and from
// the world (the learner, 26.6). A lesson is proposed, checked on the Mac,
// scored by Jev, offered as a card when it's good and the pace allows, and only
// a person applies it. Applied, it becomes a memory note, a skill or a rule, or
// an experiment with a review date; a review keeps it or retires it, and a
// retired lesson is taken back out (the record keeps why).

export const LESSON_APPLY_AS = ["principle", "procedure", "rule", "experiment"] as const;
export type LessonApplyAs = (typeof LESSON_APPLY_AS)[number];
export const EVIDENCE_KINDS = ["data", "case_study", "expert", "vendor", "team", "results"] as const;
export const LESSON_LIMITS = { lesson: 300, why: 500, how: 800, sources: 3, title: 120 } as const;
export const REVIEW_DAYS = 28;
/** A lesson from the learner becomes a card only at or above this score (0-100). */
export const CARD_MIN_SCORE = 60;
export const LESSON_CARD_SOURCE = "tethr-lesson";
/** Two lessons this alike (shared words) are the same lesson. */
export const DUPLICATE_OVERLAP = 0.6;

export type Lesson = typeof tethrLessons.$inferSelect;

export class LessonError extends Error {}

export interface LessonInput {
  area: string;
  lesson: string;
  why: string;
  howToApply: string;
  applyAs: LessonApplyAs;
  sources: LessonSource[];
  evidence: string;
}

const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);

/** Check and tidy a proposed lesson; throws LessonError with a plain message. */
export function parseLesson(raw: Record<string, unknown>): LessonInput {
  const lesson = oneLine(raw.lesson, LESSON_LIMITS.lesson + 1);
  if (lesson.length < 15) throw new LessonError("Say the lesson in one sentence (15 to 300 characters).");
  if (lesson.length > LESSON_LIMITS.lesson) throw new LessonError(`The lesson is over ${LESSON_LIMITS.lesson} characters; say it in one sentence.`);
  const area = typeof raw.area === "string" && (isAreaId(raw.area) || raw.area === "general") ? raw.area : "general";
  const sources: LessonSource[] = [];
  for (const s of Array.isArray(raw.sources) ? raw.sources.slice(0, LESSON_LIMITS.sources) : []) {
    const url = typeof s === "string" ? s : typeof (s as { url?: unknown })?.url === "string" ? (s as { url: string }).url : "";
    if (!/^https:\/\/[^\s]+$/i.test(url.trim()) || !domainOf(url)) continue;
    const title = typeof (s as { title?: unknown })?.title === "string" ? oneLine((s as { title: string }).title, LESSON_LIMITS.title) : domainOf(url)!;
    sources.push({ url: url.trim(), title });
  }
  return {
    area,
    lesson,
    why: oneLine(raw.why, LESSON_LIMITS.why),
    howToApply: oneLine(raw.how_to_apply ?? raw.howToApply, LESSON_LIMITS.how),
    applyAs: pick(raw.apply_as ?? raw.applyAs, LESSON_APPLY_AS, "principle"),
    sources,
    evidence: pick(raw.evidence, EVIDENCE_KINDS, "expert"),
  };
}

/** Why a lesson can't be kept (hidden instructions, someone's health, a key, a medical claim), or null. */
export function lessonRefusal(l: LessonInput): string | null {
  const text = `${l.lesson}\n${l.why}\n${l.howToApply}`;
  const injected = injectionReason(text);
  if (injected) return `It reads like an instruction to tethr, not a lesson (${injected}).`;
  const person = needsPersonReason(text);
  if (person) return `It can't be kept: ${person}.`;
  const medical = medicalClaimReason(text);
  if (medical) return `It was dropped: ${medical}.`;
  return null;
}

const STOP = new Set("the a an and or of to in on for with is are be it its that this by as at from your you we our they their more most than into can will".split(" "));
function words(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
}

/** How alike two lessons are (shared words over all words, 0-1). */
export function overlap(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

const SCALES = {
  fit: { instructions: "How well does this lesson fit this business (what it sells and who it sells to)?", levels: ["Doesn't fit", "Barely fits", "Fits somewhat", "Fits well", "Made for it"] },
  evidence: {
    instructions: "How strong is the evidence behind this lesson (consider the kind of evidence and the sources' track record)?",
    levels: ["None", "A vendor's claim or opinion", "An expert's view or one case", "Several cases or solid data", "Strong data"],
  },
  usable: { instructions: "Could a small team act on this lesson this month?", levels: ["No", "With a lot of work", "Yes, with some work", "Yes, easily"] },
  novel: { instructions: "How new is this lesson compared to what the business already knows (listed)?", levels: ["Already known", "Mostly known", "Partly new", "New"] },
};

function cardText(l: Lesson): string {
  const how = l.howToApply ? `\n\n**How to apply it:** ${l.howToApply}` : "";
  const why = l.why ? `\n\n${l.why}` : "";
  const sources = l.sources.length ? `\n\nSources: ${l.sources.map((s) => `[${s.title}](${s.url})`).join(", ")}` : "";
  return `**${l.lesson}**${why}${how}${sources}`;
}

export function areaName(area: string): string {
  return isAreaId(area) ? areaById(area).name : "General";
}

export function lessonsService(db: Db, deps: DecideDeps = {}) {
  const now = () => deps.now ?? new Date();

  async function get(companyId: string, id: string): Promise<Lesson> {
    const [row] = await db.select().from(tethrLessons).where(and(eq(tethrLessons.id, id), eq(tethrLessons.companyId, companyId)));
    if (!row) throw new LessonError("There's no such lesson.");
    return row;
  }

  async function update(id: string, patch: Partial<typeof tethrLessons.$inferInsert>): Promise<Lesson> {
    const [row] = await db.update(tethrLessons).set({ ...patch, updatedAt: now() }).where(eq(tethrLessons.id, id)).returning();
    return row;
  }

  async function card(l: Lesson): Promise<Lesson> {
    if (l.cardRunId) return l;
    const at = now();
    const [run] = await db
      .insert(tethrRouteRuns)
      .values({
        companyId: l.companyId,
        requestText: `Lesson · ${areaName(l.area)} · from ${l.proposedBy}`,
        invocationSource: "chat",
        threadId: chats.mainThreadId(l.companyId),
        sourceKey: LESSON_CARD_SOURCE,
        status: "done",
        resultText: cardText(l),
        hops: [],
        createdAt: at,
        updatedAt: at,
      })
      .returning({ id: tethrRouteRuns.id });
    return update(l.id, { cardRunId: run.id, status: "proposed" });
  }

  /**
   * A lesson is proposed (by the learner, by tethr from a correction, or by a
   * person). Refused or a repeat: LessonError. Otherwise it's recorded, scored
   * by Jev, and offered as a card when it's from tethr's own chats (a person is
   * there to say yes), or when it's good enough and the ideas pace allows.
   */
  async function propose(companyId: string, raw: Record<string, unknown>, by: string): Promise<{ lesson: Lesson; offered: boolean }> {
    const input = parseLesson(raw);
    const refusal = lessonRefusal(input);
    if (refusal) throw new LessonError(refusal);
    const known = await db
      .select({ lesson: tethrLessons.lesson })
      .from(tethrLessons)
      .where(and(eq(tethrLessons.companyId, companyId), ne(tethrLessons.status, "rejected")));
    const repeat = known.find((k) => overlap(k.lesson, input.lesson) >= DUPLICATE_OVERLAP);
    if (repeat) throw new LessonError(`tethr already has this lesson: "${repeat.lesson}".`);

    let [lesson] = await db
      .insert(tethrLessons)
      .values({ companyId, ...input, proposedBy: by, status: "candidate", createdAt: now(), updatedAt: now() })
      .returning();
    const profile = await companyProfileService(db).get(companyId);
    const scored = await scoreWithJev(
      db,
      companyId,
      {
        kind: "lesson.score",
        label: input.lesson.slice(0, 120),
        subjectId: lesson.id,
        state: {
          company: profile?.sells || profile?.name || "",
          lesson: input.lesson,
          why: input.why,
          how_to_apply: input.howToApply,
          evidence_kind: input.evidence,
          sources: input.sources.map((s) => domainOf(s.url)),
          trusted_sources: trustedSources(companyId),
          already_known: known.slice(0, 30).map((k) => k.lesson),
        },
        scales: SCALES,
      },
      deps,
    );
    if (scored.ok) {
      const composite = Math.round(
        (["fit", "evidence", "usable", "novel"].map((k) => scored.scores[k] ?? 0).reduce((n, v) => n + v, 0) / 4) * 100,
      );
      lesson = await update(lesson.id, {
        scores: { fit: scored.scores.fit ?? null, evidence: scored.scores.evidence ?? null, usable: scored.scores.usable ?? null, novel: scored.scores.novel ?? null, composite },
        composite,
      });
    }
    const fromChat = !by.startsWith("@") || by === "@tethr";
    const good = (lesson.composite ?? 0) >= CARD_MIN_SCORE;
    if (fromChat) return { lesson: await card(lesson), offered: true };
    if (!good) return { lesson, offered: false };
    const ideas = getSetup(companyId).ideas;
    if (!canSpend(getPace(companyId, ideas, now()))) return { lesson, offered: false };
    await updatePace(companyId, ideas, spend, now());
    return { lesson: await card(lesson), offered: true };
  }

  async function scoreDecision(companyId: string, lessonId: string): Promise<string | null> {
    const [row] = await db
      .select({ id: tethrDecisions.id })
      .from(tethrDecisions)
      .where(and(eq(tethrDecisions.companyId, companyId), eq(tethrDecisions.kind, "lesson.score"), eq(tethrDecisions.subjectId, lessonId)))
      .limit(1);
    return row?.id ?? null;
  }

  /** A person applies a lesson: it becomes a note, a skill, a rule or an experiment, with a review date. */
  async function apply(companyId: string, id: string, actor: string): Promise<Lesson> {
    const l = await get(companyId, id);
    if (!["candidate", "proposed"].includes(l.status)) throw new LessonError(`It's already ${l.status}.`);
    const area = isAreaId(l.area) ? { area: l.area } : {};
    const reviewAt = new Date(now().getTime() + REVIEW_DAYS * DAY);
    let applied: { as: string; ref: string; existed?: boolean };
    if (l.applyAs === "procedure" && memoryBackend(companyId) === "hermes") {
      const name = `lesson-${l.lesson.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48)}`;
      const description = l.lesson.length > SKILL_DESCRIPTION_MAX ? `${l.lesson.slice(0, SKILL_DESCRIPTION_MAX - 1)}…` : l.lesson;
      const body = [`# ${l.lesson}`, "", l.why, "", "## How", l.howToApply || l.lesson, ...(l.sources.length ? ["", "## Sources", ...l.sources.map((s) => `- ${s.title}: ${s.url}`)] : [])].join("\n");
      await saveSkill(companyId, { name, description, body });
      if (isAreaId(l.area)) await setSkillArea(companyId, name, l.area);
      applied = { as: "skill", ref: name };
    } else {
      const text =
        l.applyAs === "rule"
          ? `Rule: ${l.lesson}`
          : l.applyAs === "experiment"
            ? `Trying until ${reviewAt.toISOString().slice(0, 10)}: ${l.lesson}${l.howToApply ? ` (${l.howToApply.slice(0, 200)})` : ""}`
            : l.applyAs === "procedure"
              ? `How we do it: ${l.lesson}${l.howToApply ? ` ${l.howToApply.slice(0, 200)}` : ""}`
              : l.lesson;
      // A note that's already there (someone saved it, or one saying the same) isn't added
      // again, and retiring the lesson leaves it. Memory has no ceiling (memory/notes.ts).
      const { notesService } = await import("../memory/notes.js");
      const saved = await notesService(db).add(companyId, { target: "company", text, by: actor, area: area.area ?? null });
      const existed = saved.duplicate;
      applied = { as: l.applyAs === "experiment" ? "experiment" : l.applyAs === "rule" ? "rule" : "memory", ref: text, ...(existed ? { existed: true } : {}) };
    }
    await scoreSources(companyId, l.sources.map((s) => s.url), "approved");
    const decision = await scoreDecision(companyId, l.id);
    if (decision) await resolveDecision(db, companyId, decision, "accepted").catch(() => {});
    return update(l.id, { status: "applied", applied: { ...applied, at: now().toISOString() }, reviewAt, outcome: null });
  }

  /** "Not for us": turned down, with an optional reason that becomes a note ("we don't cold call"). */
  async function reject(companyId: string, id: string, actor: string, reason?: string): Promise<Lesson> {
    const l = await get(companyId, id);
    if (!["candidate", "proposed"].includes(l.status)) throw new LessonError(`It's already ${l.status}.`);
    const why = oneLine(reason, 300);
    if (why) {
      const { notesService } = await import("../memory/notes.js");
      await notesService(db).add(companyId, { target: "company", text: `Not for us: ${why}`, by: actor, area: isAreaId(l.area) ? l.area : null });
    }
    await scoreSources(companyId, l.sources.map((s) => s.url), "rejected");
    const decision = await scoreDecision(companyId, l.id);
    if (decision) await resolveDecision(db, companyId, decision, "corrected", { correctedTo: "rejected" }).catch(() => {});
    return update(l.id, { status: "rejected", outcome: why || "Not for us." });
  }

  /** tethr's review suggests keeping or retiring an applied lesson; a person confirms. */
  async function suggestVerdict(companyId: string, id: string, verdict: "kept" | "retired", note: string): Promise<Lesson> {
    const l = await get(companyId, id);
    if (l.status !== "applied") throw new LessonError("Only an applied lesson is reviewed.");
    const text = oneLine(note, 400);
    const injected = injectionReason(text);
    if (injected) throw new LessonError(`The note reads like an instruction (${injected}).`);
    return update(l.id, { verdict, outcome: text || null });
  }

  /** A person keeps or retires an applied lesson. Retiring takes it back out of memory or skills. */
  async function settle(companyId: string, id: string, keep: boolean, actor: string): Promise<Lesson> {
    const l = await get(companyId, id);
    if (l.status !== "applied") throw new LessonError("Only an applied lesson can be kept or retired.");
    // Retiring takes out exactly what applying put in; if that can't be done, nothing is marked retired.
    if (!keep && l.applied && !l.applied.existed) {
      if (l.applied.as === "skill") await deleteSkill(companyId, l.applied.ref);
      else {
        const { notesService } = await import("../memory/notes.js");
        const notes = notesService(db);
        const same = (await notes.search(companyId, l.applied.ref, { target: "company", limit: 20 })).filter((n) => n.text === l.applied!.ref);
        if (same.length !== 1) {
          throw new LessonError("Its note was changed or removed since it was applied. Edit it on the Memory page, then retire the lesson.");
        }
        await notes.remove(companyId, { target: "company", id: same[0]!.id });
      }
    }
    await scoreSources(companyId, l.sources.map((s) => s.url), keep ? "kept" : "retired");
    return update(l.id, { status: keep ? "kept" : "retired", verdict: null, outcome: l.outcome ?? (keep ? "Kept." : "Retired.") });
  }

  async function due(companyId: string): Promise<Lesson[]> {
    return db
      .select()
      .from(tethrLessons)
      .where(and(eq(tethrLessons.companyId, companyId), eq(tethrLessons.status, "applied"), lte(tethrLessons.reviewAt, now())))
      .orderBy(tethrLessons.reviewAt)
      .limit(20);
  }

  async function list(companyId: string, statuses?: string[]): Promise<Lesson[]> {
    return db
      .select()
      .from(tethrLessons)
      .where(and(eq(tethrLessons.companyId, companyId), ...(statuses?.length ? [inArray(tethrLessons.status, statuses)] : [])))
      .orderBy(desc(tethrLessons.createdAt))
      .limit(300);
  }

  /** Offer a waiting lesson as a card (from the Learning page). */
  async function offer(companyId: string, id: string): Promise<Lesson> {
    const l = await get(companyId, id);
    if (l.status !== "candidate") throw new LessonError(`It's already ${l.status}.`);
    return card(l);
  }

  return { get, propose, apply, reject, suggestVerdict, settle, due, list, offer };
}
