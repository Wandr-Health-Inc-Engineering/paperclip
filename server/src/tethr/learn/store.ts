import { companyStore } from "../company-store.js";
import type { LearningPace } from "./learning-pace.js";

// What the learning loops keep besides the lessons (phase 26.5-26.6), per
// company, in the instance-dir tethr-learning.json: the learner's switch and
// its agent, the topics queued for it, each source's track record, how each
// study area is doing, and the rules people gave when they turned a lesson down.

export const STUDY_AREAS = ["distribution", "sales", "customer experience"] as const;
export type StudyArea = (typeof STUDY_AREAS)[number];

export interface SourceRecord {
  approved: number;
  rejected: number;
  kept: number;
  retired: number;
}

export interface LearningState {
  /** The learner is switched on (Integrations → Learning). */
  enabled?: boolean;
  agentTag?: string;
  /** How often it watches and how much it studies on its own (learning-pace.ts). */
  pace?: LearningPace;
  /** Its skills save on their own (default), or each comes as a card first. */
  applyMode?: "auto" | "ask";
  /** When it last looked at what's been happening (the next digest starts there). */
  watchedAt?: string;
  /** When it last tidied memory (a weekly tidy). */
  tidiedAt?: string;
  /** Topics a person or tethr queued for the learner, oldest first. */
  queue?: Array<{ topic: string; by: string; at: string }>;
  /** By web domain. */
  sources?: Record<string, SourceRecord>;
  /** Per study area: lessons proposed and turned down, and when it was last studied. */
  areas?: Partial<Record<StudyArea, { proposed: number; rejected: number; lastStudied?: string }>>;
}

export const learningStore = companyStore<LearningState>("TETHR_LEARNING_FILE", "tethr-learning.json");

export function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/** Record how a lesson's sources did (approved, rejected, kept, retired). */
export async function scoreSources(companyId: string, urls: string[], field: keyof SourceRecord): Promise<void> {
  const domains = [...new Set(urls.map(domainOf).filter((d): d is string => !!d))];
  if (!domains.length) return;
  await learningStore.update(companyId, (s) => {
    const sources = { ...(s.sources ?? {}) };
    for (const d of domains) {
      const r = sources[d] ?? { approved: 0, rejected: 0, kept: 0, retired: 0 };
      sources[d] = { ...r, [field]: r[field] + 1 };
    }
    return { ...s, sources };
  });
}

/** Sources that have earned trust (more approved and kept than turned down and retired), best first. */
export function trustedSources(companyId: string, limit = 8): string[] {
  const sources = learningStore.get(companyId).sources ?? {};
  return Object.entries(sources)
    .map(([d, r]) => ({ d, score: r.approved + 2 * r.kept - r.rejected - 2 * r.retired }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.d);
}

/** Sources that keep getting turned down. */
export function distrustedSources(companyId: string, limit = 8): string[] {
  const sources = learningStore.get(companyId).sources ?? {};
  return Object.entries(sources)
    .filter(([, r]) => r.rejected + 2 * r.retired >= 2 && r.rejected + 2 * r.retired > r.approved + 2 * r.kept)
    .slice(0, limit)
    .map(([d]) => d);
}
