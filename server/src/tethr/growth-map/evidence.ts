import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tethrRouteRuns } from "@paperclipai/db";
import { companyProfileService } from "../company.js";
import { goalsService } from "../goals.js";
import { memorySnapshot } from "../hermes/memory-layer.js";
import { getIntegrations, modeFor, type IntegrationsConfig } from "../integrations.js";
import { getSetup } from "../setup.js";
import { teamService } from "../team.js";
import { googleAdsConfigured } from "../tools/google-ads.js";
import { CONNECTOR_OF, GROWTH_AREAS, type AreaSchedule, type DataSource } from "./areas.js";
import { computeGrowthMap, type GrowthMapView, type MapEvidence } from "./map.js";
import { getMapState } from "./store.js";

// Gathers what the growth map is worked out from (phase 26.9): memory notes and
// skills, goal metrics, the team, connections, schedules and the playbooks on
// this machine. Reads only; nothing here starts anything.

/** Email domains that say nothing about which company someone works at. */
const FREEMAIL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com"]);

/** Where the playbooks (Claude Code skills) live on this machine. */
export function playbooksDir(): string {
  return process.env.TETHR_SKILLS_DIR || path.join(os.homedir(), ".claude", "skills");
}

export function installedPlaybooks(): Set<string> {
  const wanted = new Set(GROWTH_AREAS.flatMap((a) => a.playbooks));
  const dir = playbooksDir();
  return new Set([...wanted].filter((name) => fs.existsSync(path.join(dir, name, "SKILL.md"))));
}

/** The company's own web domain, from the addresses that count as inside it. */
export function companyDomain(cfg: IntegrationsConfig): string | null {
  for (const entry of cfg.internalAddresses) {
    const domain = entry.trim().toLowerCase().replace(/^.*@/, "").replace(/^\*\./, "");
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) && !FREEMAIL.has(domain)) return domain;
  }
  return null;
}

type DataStatus = MapEvidence["data"][DataSource];

function connectorStatus(cfg: IntegrationsConfig, label: string): DataStatus {
  const fix = `Connect ${label} as a claude.ai connector and give it a mode on Integrations; tethr sees it from its next chat.`;
  if (modeFor(cfg, label) === "off") return { connected: false, detail: `${label} is switched off.`, fix: `Switch ${label} on in Integrations.` };
  if (!(cfg.discovered?.connectors[label]?.length ?? 0)) return { connected: false, detail: `tethr hasn't seen ${label} yet.`, fix };
  return { connected: true, detail: `${label} is connected.`, fix };
}

export function dataStatus(cfg: IntegrationsConfig, sells: string): MapEvidence["data"] {
  const domain = companyDomain(cfg);
  const connector = (source: DataSource) => connectorStatus(cfg, CONNECTOR_OF[source]!);
  return {
    google_ads: googleAdsConfigured()
      ? { connected: true, detail: "Google Ads is connected.", fix: "" }
      : { connected: false, detail: "Google Ads isn't set up.", fix: "Add the Google Ads settings on the Environment page." },
    stripe: connector("stripe"),
    posthog: connector("posthog"),
    gmail: connector("gmail"),
    slack: connector("slack"),
    website: domain
      ? { connected: true, detail: `tethr reads ${domain}.`, fix: "" }
      : { connected: false, detail: "tethr doesn't know the company's website.", fix: "Add the company's email domain on Integrations (inside the company)." },
    profile: sells.trim()
      ? { connected: true, detail: "What the company sells is set in setup.", fix: "" }
      : { connected: false, detail: "What the company sells isn't set.", fix: "Say what the company sells in setup step 1." },
  };
}

async function runningAgentIds(db: Db, agentIds: string[]): Promise<Set<string>> {
  if (!agentIds.length) return new Set();
  const rows = await db
    .select({ agentId: tethrRouteRuns.agentId })
    .from(tethrRouteRuns)
    .where(and(inArray(tethrRouteRuns.agentId, agentIds), inArray(tethrRouteRuns.status, ["queued", "running"])));
  return new Set(rows.map((r) => r.agentId).filter((id): id is string => !!id));
}

export async function gatherEvidence(db: Db, companyId: string): Promise<MapEvidence> {
  const [profile, goals, team] = await Promise.all([
    companyProfileService(db).get(companyId),
    goalsService(db).list(companyId),
    teamService(db).list(companyId),
  ]);
  const running = await runningAgentIds(db, team.map((a) => a.agentId));
  const cfg = getIntegrations(companyId);
  const memory = memorySnapshot(companyId);
  const setup = getSetup(companyId);
  const schedulesOn: AreaSchedule[] = setup.rhythm.scorecard.enabled ? ["scorecard"] : [];
  return {
    companyName: profile?.name ?? "Your company",
    timezone: setup.timezone,
    state: getMapState(companyId),
    notes: [...memory.stores.company.entries, ...memory.stores.people.entries].map((e) => ({
      text: e.text,
      ...(e.area ? { area: e.area } : {}),
      ...(e.savedBy ? { savedBy: e.savedBy } : {}),
      ...(e.savedAt ? { savedAt: e.savedAt } : {}),
    })),
    skills: memory.skills,
    metrics: goals.goals.flatMap((g) =>
      g.metrics.map((m) => ({
        id: m.id,
        name: m.name,
        goalTitle: g.title,
        unit: m.unit,
        baseline: m.baseline,
        baselineAt: m.baselineAt,
        target: m.target,
        targetDate: m.targetDate,
        current: m.current,
        measurements: (m.history ?? []).length,
      })),
    ),
    agents: team.map((a) => ({ tag: a.tag, name: a.name, title: a.title, mission: a.mission, paused: a.paused, running: running.has(a.agentId) })),
    data: dataStatus(cfg, profile?.sells ?? ""),
    schedulesOn,
    installedPlaybooks: installedPlaybooks(),
  };
}

/** The company's growth map as it stands now. */
export async function growthMap(db: Db, companyId: string, now: Date = new Date()): Promise<GrowthMapView> {
  return computeGrowthMap(await gatherEvidence(db, companyId), now);
}
