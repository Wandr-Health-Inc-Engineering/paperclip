import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GROWTH_AREAS, areaById } from "./areas.js";
import { sortIntoArea } from "./sort.js";

// The playbooks (Claude Code skills) behind each growth area, and the rule that
// tethr and its agents load them before they plan or write in that area. Mark,
// 2026-11-10: a small-budget Google Ads ask came back as five ad groups; the
// paid-ads playbook (installed, never loaded that turn) warns against exactly
// that. The playbooks are how tethr knows a channel well; general knowledge is
// the fallback.

/** Where the playbooks live on this machine. */
export function playbooksDir(): string {
  return process.env.TETHR_SKILLS_DIR || path.join(os.homedir(), ".claude", "skills");
}

/** The growth areas' playbooks that are installed here. */
export function installedPlaybooks(): Set<string> {
  const wanted = new Set(GROWTH_AREAS.flatMap((a) => a.playbooks));
  const dir = playbooksDir();
  return new Set([...wanted].filter((name) => fs.existsSync(path.join(dir, name, "SKILL.md"))));
}

/** A skill tethr or the learner saved, placed on a growth-map area (skill_view loads it). */
export interface LearnedSkill {
  name: string;
  area: string;
}

/**
 * The CLAUDE.md section that names each area's playbooks and learned skills and
 * says to load them first. Null when there are neither.
 */
export function playbooksContextText(installed: Set<string>, learned: LearnedSkill[] = []): string | null {
  const rows = GROWTH_AREAS.map((a) => ({
    name: a.name,
    playbooks: a.playbooks.filter((p) => installed.has(p)),
    learned: learned.filter((l) => l.area === a.id).map((l) => l.name),
  })).filter((r) => r.playbooks.length || r.learned.length);
  if (!rows.length) return null;
  const parts = (r: (typeof rows)[number]) =>
    [r.playbooks.join(", "), r.learned.length ? `learned: ${r.learned.join(", ")} (skill_view)` : ""].filter(Boolean).join("; ");
  return [
    "## Playbooks",
    "Expert playbooks are installed as skills, and the learned skills are what this company learned for itself. They're how you know a channel well; your general knowledge is only the fallback.",
    "- Before you plan, size, recommend, write or review anything in one of these areas, load its playbook with the Skill tool and its learned skills with skill_view in that turn, and follow them. Once per conversation is enough. Where a learned skill and a playbook differ, the learned skill is about this company: it wins.",
    '- Say in a clause which playbook or skill a recommendation follows ("per the paid-ads playbook, …").',
    "- When the playbook asks for something you don't know (budget, goal, what's been tried), check goals, memory and the connectors first; ask the person only for what's still missing, with the ask tool.",
    ...rows.map((r) => `- ${r.name}: ${parts(r)}`),
  ].join("\n");
}

/** Learned skills placed on an area, for the Playbooks section. */
export function learnedSkills(skills: Array<{ name: string }>, areas: Record<string, string>): LearnedSkill[] {
  return skills.filter((s) => typeof areas[s.name] === "string").map((s) => ({ name: s.name, area: areas[s.name]! }));
}

/** The installed playbooks for whatever area a job description is clearly about (none when it isn't clear). */
export function playbooksForJob(job: string, installed: Set<string>): string[] {
  const area = sortIntoArea(job);
  return area ? areaById(area).playbooks.filter((p) => installed.has(p)) : [];
}
