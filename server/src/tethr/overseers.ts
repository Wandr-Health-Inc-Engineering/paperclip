import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

// The overseer roster: who gets buzzed for each role. Agents route by their
// overseerRole (tech | exec | growth) — a new tech agent alerts Frank, a growth
// agent alerts Mark, etc. Stored as per-company local config (like the drive
// mounts) so the human, not an agent, owns it. Seeded from env if provided.

export const OVERSEER_ROLES = ["tech", "exec", "growth"] as const;
export type OverseerRole = (typeof OVERSEER_ROLES)[number];

export interface OverseerPerson {
  name: string;
  slackId: string;
}
export type OverseerRoster = Record<OverseerRole, OverseerPerson>;

interface RosterFile {
  [companyId: string]: Partial<OverseerRoster>;
}

function rosterConfigPath(): string {
  if (process.env.TETHR_OVERSEERS_FILE) return process.env.TETHR_OVERSEERS_FILE;
  return path.resolve(resolvePaperclipInstanceRoot(), "tethr-overseers.json");
}

/** Defaults, filled from env when set. Names describe the role until Mark sets
 * real people (tech = Frank, exec = Alec, growth = Mark, per his setup). */
function envDefault(role: OverseerRole): OverseerPerson {
  const up = role.toUpperCase();
  const fallbackName = { tech: "Tech lead", exec: "Exec", growth: "Growth & Ops" }[role];
  return {
    name: process.env[`TETHR_OVERSEER_${up}_NAME`]?.trim() || fallbackName,
    slackId: process.env[`TETHR_OVERSEER_${up}_SLACK_ID`]?.trim() || "",
  };
}

function readFile(): RosterFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(rosterConfigPath(), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as RosterFile) : {};
  } catch {
    return {};
  }
}

/** The full roster for a company — stored overrides layered over env defaults. */
export function getRoster(companyId: string): OverseerRoster {
  const stored = readFile()[companyId] ?? {};
  const roster = {} as OverseerRoster;
  for (const role of OVERSEER_ROLES) {
    const s = stored[role];
    roster[role] = {
      name: s?.name?.trim() || envDefault(role).name,
      slackId: s?.slackId?.trim() || envDefault(role).slackId,
    };
  }
  return roster;
}

export async function setRoster(companyId: string, roster: Partial<OverseerRoster>): Promise<OverseerRoster> {
  const all = readFile();
  const next: Partial<OverseerRoster> = { ...(all[companyId] ?? {}) };
  for (const role of OVERSEER_ROLES) {
    const incoming = roster[role];
    if (incoming) {
      next[role] = { name: String(incoming.name ?? "").trim(), slackId: String(incoming.slackId ?? "").trim() };
    }
  }
  all[companyId] = next;
  const p = rosterConfigPath();
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, JSON.stringify(all, null, 2), "utf8");
  return getRoster(companyId);
}

export function normalizeOverseerRole(value: unknown): OverseerRole {
  return (OVERSEER_ROLES as readonly string[]).includes(String(value)) ? (value as OverseerRole) : "growth";
}

/** Infer an overseer role from an agent's role/mission text — used when the CEO
 * (or the factory) creates a new agent, so it routes to the right person. */
export function inferOverseerRole(text: string): OverseerRole {
  const t = text.toLowerCase();
  if (/\b(engineer|engineering|tech|technical|bug|debug|infra|reliability|devops|backend|frontend|qa|security|data)\b/.test(t)) {
    return "tech";
  }
  if (/\b(strategy|strategic|executive|priorit|finance|financial|budget|board|fundrais|legal)\b/.test(t)) {
    return "exec";
  }
  return "growth";
}
