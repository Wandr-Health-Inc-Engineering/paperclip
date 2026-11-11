import { companyStore } from "../company-store.js";
import type { StudyDepth } from "../assistant/sandbox.js";

// What the learner's studies leave behind (2026-11-10), per company, in the
// instance-dir tethr-studies.json: each study's plan, findings, verdicts and the
// skill changes it made (with what each skill said before, for Undo), and which
// skills the learner made (it may update only those on its own).

export const STUDY_STATUSES = ["queued", "planning", "researching", "applying", "done", "nothing", "failed", "stopped"] as const;
export type StudyStatus = (typeof STUDY_STATUSES)[number];
export const FINDING_STRENGTHS = ["strong", "moderate", "weak"] as const;
export const FINDING_EVIDENCE = ["data", "case_study", "expert", "vendor", "anecdote"] as const;
export const VERDICTS = ["new", "confirms", "contradicts", "not_for_us"] as const;

export interface Source {
  url: string;
  title: string;
}

export interface Finding {
  claim: string;
  detail: string;
  evidence: (typeof FINDING_EVIDENCE)[number];
  strength: (typeof FINDING_STRENGTHS)[number];
  sources: Source[];
  appliesWhen: string | null;
  counterpoint: string | null;
}

export interface Verdict {
  /** 1-based, as the apply room saw the findings. */
  finding: number;
  verdict: (typeof VERDICTS)[number];
  note: string;
}

export interface SkillChange {
  name: string;
  description: string;
  area: string;
  change: "new" | "updated";
  whatChanged: string;
  body: string;
  /** What the skill said before an update (Undo puts it back); null for a new skill. */
  before: { description: string; body: string } | null;
  /** applied (saved), pending (an Ask-first card), refused (the card was turned down), undone. */
  status: "applied" | "pending" | "refused" | "undone";
  /** The Ask-first card, when there is one. */
  outputId?: string;
  at: string;
}

export interface NoteChange {
  action: "merge" | "rewrite" | "retire";
  /** The notes it touches (the first keeps the new text on a merge). */
  ids: string[];
  /** What they said before (for the card and the record). */
  before: string[];
  text: string | null;
  why: string;
  /** applied, or pending (a person's note: a card), or refused (the card was turned down). */
  status: "applied" | "pending" | "refused";
  outputId?: string;
}

export interface Study {
  id: string;
  /** learn: plan → research → apply. review: the apply room alone, checking that tethr's skills hold as the
   * company grows. tidy: the apply room alone, merging and refreshing memory notes. */
  kind?: "learn" | "review" | "tidy";
  /** A tidy's changes to notes. */
  tidied?: NoteChange[];
  trigger: "observed" | "asked";
  /** Who asked (a person's name, "@tethr"), or "@sage" when it chose on its own. */
  by: string;
  /** The topic as asked, before planning. */
  asked: string | null;
  status: StudyStatus;
  depth: StudyDepth;
  topic: string | null;
  why: string | null;
  area: string | null;
  questions: string[];
  /** What tethr does or believes now (from the plan room; never sent to the web room). */
  baseline: string | null;
  findings: Finding[];
  researchSummary: string | null;
  verdicts: Verdict[];
  summary: string | null;
  skills: SkillChange[];
  /** Why there was nothing to study, or why it failed or stopped. */
  reason: string | null;
  runs: { plan?: string; research?: string; apply?: string };
  /** The card in the learner's chat and, when something changed, in tethr's main chat. */
  cardRunId: string | null;
  mainCardRunId: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface StudiesState {
  studies?: Study[];
  /** Skills the learner made: it may update or undo only these. */
  origins?: Record<string, { studyId: string; at: string }>;
}

export const MAX_STUDIES_KEPT = 100;
export const studiesStore = companyStore<StudiesState>("TETHR_STUDIES_FILE", "tethr-studies.json");

export function listStudies(companyId: string): Study[] {
  return studiesStore.get(companyId).studies ?? [];
}

export function getStudy(companyId: string, id: string): Study | null {
  return listStudies(companyId).find((s) => s.id === id) ?? null;
}

/** The study a plan, research or apply turn belongs to (by its run id). */
export function studyForRun(companyId: string, runId: string): Study | null {
  return listStudies(companyId).find((s) => s.runs.plan === runId || s.runs.research === runId || s.runs.apply === runId) ?? null;
}

export async function saveStudy(companyId: string, study: Study): Promise<Study> {
  await studiesStore.update(companyId, (s) => {
    const others = (s.studies ?? []).filter((x) => x.id !== study.id);
    return { ...s, studies: [study, ...others].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, MAX_STUDIES_KEPT) };
  });
  return study;
}

/** Change one study (read-modify-write in the store's own lock). Null when it's gone. */
export async function updateStudy(companyId: string, id: string, fn: (s: Study) => Study): Promise<Study | null> {
  let out: Study | null = null;
  await studiesStore.update(companyId, (s) => {
    const studies = (s.studies ?? []).map((x) => {
      if (x.id !== id) return x;
      out = fn(x);
      return out;
    });
    return { ...s, studies };
  });
  return out;
}

export function skillOrigin(companyId: string, name: string): { studyId: string; at: string } | null {
  return studiesStore.get(companyId).origins?.[name] ?? null;
}

export async function setSkillOrigin(companyId: string, name: string, origin: { studyId: string; at: string } | null): Promise<void> {
  await studiesStore.update(companyId, (s) => {
    const origins = { ...(s.origins ?? {}) };
    if (origin) origins[name] = origin;
    else delete origins[name];
    return { ...s, origins };
  });
}

/** Studies started since `since` (by trigger, when given). */
export function studiesSince(companyId: string, since: Date, trigger?: Study["trigger"]): Study[] {
  return listStudies(companyId).filter((s) => Date.parse(s.startedAt) >= since.getTime() && (!trigger || s.trigger === trigger));
}

export const ACTIVE_STUDY: ReadonlySet<StudyStatus> = new Set(["queued", "planning", "researching", "applying"]);

/** The study a card stands for (in the learner's chat or tethr's main chat), for the chat's runs. */
export function studyCardOf(companyId: string, cardRunId: string): Study | null {
  return listStudies(companyId).find((s) => s.cardRunId === cardRunId || s.mainCardRunId === cardRunId) ?? null;
}
