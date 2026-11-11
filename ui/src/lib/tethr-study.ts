import type { TethrStudy } from "@/api/tethr";

// Wording for the learner's study cards and the Learning page (2026-11-10).
// A study goes Looking → Researching → Comparing → Done; it can also end with
// nothing to study, fail or be stopped.

export const STUDY_STEPS = [
  { status: "planning", label: "Looking" },
  { status: "researching", label: "Researching" },
  { status: "applying", label: "Comparing" },
  { status: "done", label: "Done" },
] as const;

export const ACTIVE_STUDY = new Set<TethrStudy["status"]>(["queued", "planning", "researching", "applying"]);

/** How far along it is (0-3), for the step rail; -1 while it waits its turn. */
export function studyStep(status: TethrStudy["status"]): number {
  if (status === "queued") return -1;
  const i = STUDY_STEPS.findIndex((s) => s.status === status);
  return i >= 0 ? i : 3;
}

export function studyTitle(s: Pick<TethrStudy, "topic" | "asked">): string {
  return s.topic ?? s.asked ?? "Looking at what's been happening";
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What it's doing, or how it ended, in one line. */
export function studyLine(s: TethrStudy): string {
  switch (s.status) {
    case "queued":
      return "Waiting for the study before it to finish.";
    case "planning":
      return s.trigger === "observed" ? "Looking at what's been happening in tethr to pick what to learn." : "Planning the study: what tethr knows now, and what to find out.";
    case "researching":
      return `Researching ${plural(s.questions.length, "question")} on the web${s.depth === "deep" ? ", in depth" : ""}.`;
    case "applying":
      return `Comparing ${plural(s.findings.length, "finding")} with what tethr knows, and saving what's worth keeping.`;
    case "nothing":
      return `Nothing worth studying this time${s.reason ? `: ${s.reason}` : "."}`;
    case "failed":
      return `Didn't finish${s.reason ? `: ${s.reason}` : "."}`;
    case "stopped":
      return `Stopped${s.reason && s.reason !== "Stopped by a person." ? `: ${s.reason}` : "."}`;
    default:
      return outcomeWords(s);
  }
}

/** "1 new skill, 1 updated · 4 findings from 9 sources". */
export function outcomeWords(s: TethrStudy): string {
  const kept = s.skills.filter((k) => k.status === "applied");
  const made = kept.filter((k) => k.change === "new").length;
  const updated = kept.filter((k) => k.change === "updated").length;
  const pending = s.skills.filter((k) => k.status === "pending").length;
  const parts = [
    made ? plural(made, "new skill") : "",
    updated ? `${updated} updated` : "",
    pending ? `${pending} waiting for your OK` : "",
  ].filter(Boolean);
  const sources = new Set(s.findings.flatMap((f) => f.sources.map((x) => x.url))).size;
  const found = s.findings.length ? `${plural(s.findings.length, "finding")} from ${plural(sources, "source")}` : "";
  return [parts.length ? parts.join(", ") : "No skill saved", found].filter(Boolean).join(" · ");
}

export const VERDICT_WORDS: Record<TethrStudy["verdicts"][number]["verdict"], string> = {
  new: "New to tethr",
  confirms: "Confirms what tethr does",
  contradicts: "Contradicts what tethr does",
  not_for_us: "Not for this company",
};

export const SKILL_STATUS_WORDS: Record<TethrStudy["skills"][number]["status"], string> = {
  applied: "Saved",
  pending: "Waiting for your OK",
  refused: "Turned down",
  undone: "Undone",
};

/** The growth map's area names (server: growth-map/areas.ts). */
const AREA_NAMES: Record<string, string> = {
  positioning: "Positioning",
  content: "Content & social",
  seo: "Search (SEO)",
  geo: "AI search (GEO)",
  paid_ads: "Paid ads",
  measurement: "Measurement",
  customer_voice: "Customer voice",
  conversion: "Conversion",
  pricing: "Pricing & offers",
  retention: "Retention",
  email: "Email & lifecycle",
  partnerships: "Partnerships",
};

export function areaLabel(area: string | null): string {
  return area ? (AREA_NAMES[area] ?? area) : "General";
}

/** The first sentence of a summary: what a card in tethr's main chat leads with. */
export function leadSentence(text: string | null): string | null {
  if (!text) return null;
  const end = text.search(/[.!?](\s|$)/);
  return end > 0 ? text.slice(0, end + 1) : text;
}
