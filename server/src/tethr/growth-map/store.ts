import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { serialize, writeAtomic } from "../atomic.js";
import type { AreaId } from "./areas.js";

// What the growth map keeps (phase 26.9), per company, in the instance-dir
// tethr-growth-map.json: the audits tethr recorded for each area, which goal
// metrics and agents belong to it, the week's focus, hidden areas, and which
// area each saved skill is about. Levels are never stored: map.ts works them out
// from this and from what already exists (memory, goals, the team, connections).

export const AUDITS_KEPT = 20;

export interface AreaAudit {
  score: number;
  summary: string;
  nextSteps: string[];
  /** The audit write-up, relative to the workspace ("files/growth-map/seo.md"). */
  file?: string;
  at: string;
  /** "@tethr" or an agent's tag. */
  by: string;
  threadId?: string;
  runId?: string;
}

export interface AreaRecord {
  /** Oldest first, at most AUDITS_KEPT. */
  audits?: AreaAudit[];
  /** Goal metrics that measure this area (set by map_area). */
  metricIds?: string[];
  /** Team agents that work this area (set by map_area). */
  agentTags?: string[];
}

export interface MapFocus {
  area: AreaId;
  at: string;
  by: string;
  why?: string;
}

export interface CompanyMapState {
  areas?: Partial<Record<AreaId, AreaRecord>>;
  hidden?: AreaId[];
  focus?: MapFocus;
  /** Saved skill name → the area it's about. */
  skillAreas?: Record<string, AreaId>;
}

interface FileShape {
  [companyId: string]: CompanyMapState;
}

export function growthMapFile(): string {
  if (process.env.TETHR_GROWTH_MAP_FILE) return process.env.TETHR_GROWTH_MAP_FILE;
  // A test that didn't pick a file never touches the real instance's record.
  if (process.env.VITEST) return path.join(os.tmpdir(), `tethr-growth-map-test-${process.pid}.json`);
  return path.resolve(resolvePaperclipInstanceRoot(), "tethr-growth-map.json");
}

function readFile(): FileShape {
  try {
    const parsed = JSON.parse(fs.readFileSync(growthMapFile(), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as FileShape) : {};
  } catch {
    return {};
  }
}

export function getMapState(companyId: string): CompanyMapState {
  return readFile()[companyId] ?? {};
}

/** Serialized read-modify-write of one company's record (atomic write). */
export function updateMapState(companyId: string, fn: (s: CompanyMapState) => CompanyMapState): Promise<CompanyMapState> {
  const file = growthMapFile();
  return serialize(file, async () => {
    const data = readFile();
    const next = fn({ ...(data[companyId] ?? {}) });
    data[companyId] = next;
    await writeAtomic(file, JSON.stringify(data, null, 2));
    return next;
  });
}

/**
 * Link goal metrics or agents to one area. A metric or agent belongs to ONE
 * area, so linking it here unlinks it everywhere else: one number or one agent
 * can never lift every area at once. `undefined` leaves that kind of link alone.
 */
export function linkToArea(companyId: string, area: AreaId, links: { metricIds?: string[]; agentTags?: string[] }): Promise<CompanyMapState> {
  return updateMapState(companyId, (s) => {
    const areas: Partial<Record<AreaId, AreaRecord>> = {};
    for (const [id, record] of Object.entries(s.areas ?? {}) as Array<[AreaId, AreaRecord]>) {
      areas[id] = {
        ...record,
        ...(links.metricIds && record.metricIds ? { metricIds: record.metricIds.filter((m) => !links.metricIds!.includes(m)) } : {}),
        ...(links.agentTags && record.agentTags ? { agentTags: record.agentTags.filter((t) => !links.agentTags!.includes(t)) } : {}),
      };
    }
    areas[area] = {
      ...(areas[area] ?? {}),
      ...(links.metricIds ? { metricIds: links.metricIds } : {}),
      ...(links.agentTags ? { agentTags: links.agentTags } : {}),
    };
    return { ...s, areas };
  });
}

export function updateAreaRecord(companyId: string, area: AreaId, fn: (r: AreaRecord) => AreaRecord): Promise<CompanyMapState> {
  return updateMapState(companyId, (s) => ({ ...s, areas: { ...(s.areas ?? {}), [area]: fn({ ...(s.areas?.[area] ?? {}) }) } }));
}

export function setAreaHidden(companyId: string, area: AreaId, hidden: boolean): Promise<CompanyMapState> {
  return updateMapState(companyId, (s) => {
    const rest = (s.hidden ?? []).filter((a) => a !== area);
    return { ...s, hidden: hidden ? [...rest, area] : rest };
  });
}

export function setSkillArea(companyId: string, skill: string, area: AreaId): Promise<CompanyMapState> {
  return updateMapState(companyId, (s) => ({ ...s, skillAreas: { ...(s.skillAreas ?? {}), [skill]: area } }));
}
