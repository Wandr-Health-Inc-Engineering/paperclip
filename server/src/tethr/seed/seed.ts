import fs from "node:fs";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  budgetPolicies,
  companies,
  costEvents,
  goals,
  heartbeatRuns,
  issues,
  projects,
  tethrAgentProfiles,
  tethrDivisions,
  tethrSubagents,
} from "@paperclipai/db";
import { TETHR_ADAPTER_TYPE } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { routineService } from "../../services/routines.js";
import { driveService } from "../drive.js";
import { gatingService } from "../gating.js";
import { memoryService } from "../memory.js";
import { notificationService } from "../notify.js";
import { routingService } from "../routing.js";
import { trackerService } from "../state.js";
import {
  AGENTS,
  COMPANY,
  COMPANY_MEMORIES,
  DIVISIONS,
  HELM,
  STANDING_RULES,
  STATE_SEEDS,
  type SpecAgent,
} from "./wandr-growth.js";

// Seed importer: turns the vendored Wandr Growth spec (and, when available,
// the live /tethr bundle markdown) into a running company. Idempotent: skips
// when the company already exists unless force is set.

const AGENT_ICONS: Record<string, string> = {
  ceo: "star",
  helm: "target",
  atlas: "file-code",
  compass: "globe",
  voyager: "rocket",
  sonar: "search",
  tailwind: "zap",
  ledger: "database",
  herald: "mail",
  beacon: "lightbulb",
};

// Deterministic PRNG so demo data is stable run-to-run.
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SeedResult {
  companyId: string;
  created: boolean;
  agents: number;
  subagents: number;
  divisions: number;
  driveFiles: number;
  demo: {
    routeRuns: number;
    decided: number;
    heartbeatRuns: number;
    costEvents: number;
    issues: number;
  };
}

export async function seedWandrGrowth(
  db: Db,
  opts: { bundlePath?: string; demo?: boolean; force?: boolean } = {},
): Promise<SeedResult> {
  const demo = opts.demo ?? true;
  const bundlePath =
    opts.bundlePath ?? process.env.TETHR_BUNDLE_PATH ?? undefined;

  const [existing] = await db
    .select()
    .from(companies)
    .where(eq(companies.name, COMPANY.name))
    .limit(1);
  if (existing && !opts.force) {
    return {
      companyId: existing.id,
      created: false,
      agents: 0,
      subagents: 0,
      divisions: 0,
      driveFiles: 0,
      demo: { routeRuns: 0, decided: 0, heartbeatRuns: 0, costEvents: 0, issues: 0 },
    };
  }

  logger.info("[tethr] seeding Wandr Growth company");
  const drive = driveService(db);
  const memory = memoryService(db);
  const notify = notificationService(db);
  const routing = routingService(db);
  const gating = gatingService(db);
  const routines = routineService(db);
  const rand = mulberry32(20260611);

  // --- Company -------------------------------------------------------------
  const [company] = existing
    ? [existing]
    : await db
        .insert(companies)
        .values({
          name: COMPANY.name,
          description: COMPANY.goal,
          status: "active",
          issuePrefix: COMPANY.issuePrefix,
          budgetMonthlyCents: COMPANY.budgetMonthlyCents,
        })
        .returning();
  const companyId = company.id;

  // --- Divisions -----------------------------------------------------------
  const divisionByKey = new Map<string, string>();
  for (const division of DIVISIONS) {
    const [row] = await db
      .insert(tethrDivisions)
      .values({
        companyId,
        key: division.key,
        name: division.name,
        description: division.description,
        status: division.status,
        icon: division.icon,
        sortOrder: division.sortOrder,
      })
      .onConflictDoNothing()
      .returning();
    if (row) divisionByKey.set(division.key, row.id);
  }
  const growthDivisionId = divisionByKey.get("growth") ?? null;

  // --- Agents + profiles + subagents ---------------------------------------
  async function createAgent(input: {
    key: string;
    name: string;
    role: string;
    title: string;
    capabilities: string;
    reportsTo: string | null;
    status: string;
    pausedReason?: string;
    budgetMonthlyCents: number;
    adapterConfig: Record<string, unknown>;
  }) {
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        name: input.name,
        role: input.role,
        title: input.title,
        icon: AGENT_ICONS[input.key] ?? "bot",
        status: input.status,
        reportsTo: input.reportsTo,
        capabilities: input.capabilities,
        adapterType: TETHR_ADAPTER_TYPE,
        adapterConfig: input.adapterConfig,
        budgetMonthlyCents: input.budgetMonthlyCents,
        ...(input.status === "paused"
          ? { pausedAt: new Date("2026-03-25T08:07:00Z"), pauseReason: input.pausedReason }
          : {}),
      })
      .returning();
    return agent;
  }

  const ceo = await createAgent({
    key: "ceo",
    name: "CEO",
    role: "ceo",
    title: "Chief Executive (placeholder — Mark today)",
    capabilities:
      "Holds the mission and sets goals. Placeholder slot per the bundle: create the slot, keep config minimal.",
    reportsTo: null,
    status: "idle",
    budgetMonthlyCents: 0,
    adapterConfig: { agentTag: "@ceo" },
  });
  await db.insert(tethrAgentProfiles).values({
    companyId,
    agentId: ceo.id,
    divisionId: null,
    tag: "@ceo",
    codename: "CEO",
    mission: "Represents the mission. Placeholder until the CEO agent is built.",
    approvalGate: "none",
    routingTable: [],
    standingRules: STANDING_RULES,
  });

  const helm = await createAgent({
    key: "helm",
    name: "Helm",
    role: "executive",
    title: HELM.role,
    capabilities: HELM.mission,
    reportsTo: ceo.id,
    status: "idle",
    budgetMonthlyCents: COMPANY.budgetMonthlyCents,
    adapterConfig: { agentTag: HELM.tag, heartbeatMode: "digest" },
  });
  await db.insert(tethrAgentProfiles).values({
    companyId,
    agentId: helm.id,
    divisionId: growthDivisionId,
    tag: HELM.tag,
    codename: HELM.codename,
    mission: HELM.mission,
    approvalGate: "none",
    heartbeatNote: "On request — routes everything, runs nothing on a clock.",
    routingTable: HELM.routing,
    standingRules: STANDING_RULES,
  });
  if (growthDivisionId) {
    await db
      .update(tethrDivisions)
      .set({ headAgentId: helm.id, updatedAt: new Date() })
      .where(eq(tethrDivisions.id, growthDivisionId));
  }

  const agentRowByKey = new Map<string, typeof helm>();
  let subagentCount = 0;
  for (const spec of AGENTS) {
    const agent = await createAgent({
      key: spec.key,
      name: spec.codename,
      role: "general",
      title: spec.role,
      capabilities: spec.mission,
      reportsTo: helm.id,
      status: spec.status === "paused" ? "paused" : "idle",
      pausedReason:
        spec.key === "sonar"
          ? "Paused in production since 2026-03-25 — first port candidate."
          : undefined,
      budgetMonthlyCents: spec.budgetMonthlyCents,
      adapterConfig: {
        agentTag: `@${spec.key}`,
        heartbeatRequest: spec.heartbeatRequest,
        subagentChain: spec.heartbeatChain,
      },
    });
    agentRowByKey.set(spec.key, agent);

    await db.insert(tethrAgentProfiles).values({
      companyId,
      agentId: agent.id,
      divisionId: growthDivisionId,
      tag: `@${spec.key}`,
      codename: spec.codename,
      mission: spec.mission,
      approvalGate: spec.approvalGate,
      heartbeatCron: spec.heartbeatCron,
      heartbeatNote: spec.heartbeatNote,
      portPriority: spec.portPriority ?? null,
      routingTable: spec.routing,
      standingRules: STANDING_RULES,
    });

    let order = 0;
    for (const sub of spec.subagents) {
      await db.insert(tethrSubagents).values({
        companyId,
        agentId: agent.id,
        key: sub.key,
        tag: `@${spec.key}.${sub.key}`,
        name: sub.name,
        job: sub.job,
        routeWhen: sub.routeWhen,
        notHere: sub.notHere,
        reads: sub.reads,
        steps: sub.steps,
        output: sub.output,
        guardrails: sub.guardrails,
        doneWhen: sub.doneWhen,
        escalation: sub.escalation,
        sensitivity: sub.sensitivity,
        sortOrder: order++,
      });
      subagentCount++;
    }
  }

  // --- Budget policies -------------------------------------------------------
  await db.insert(budgetPolicies).values({
    companyId,
    scopeType: "company",
    scopeId: companyId,
    metric: "billed_cents",
    windowKind: "calendar_month_utc",
    amount: COMPANY.budgetMonthlyCents,
    warnPercent: 80,
    hardStopEnabled: false,
    createdByUserId: "tethr-seed",
  });
  for (const spec of AGENTS) {
    const agent = agentRowByKey.get(spec.key);
    if (!agent) continue;
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: agent.id,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: spec.budgetMonthlyCents,
      warnPercent: 80,
      // Every autonomous agent keeps its stated cap as a real hard stop (Phase 3):
      // at 80% it warns, at 100% core pauses the agent and cancels in-flight work.
      // (Previously only Tailwind hard-stopped and the rest warned only — that left
      // the per-agent caps unenforced, which the buildout forbids. Cost only accrues
      // on live runs, so mock/dev never trips this.)
      hardStopEnabled: true,
      createdByUserId: "tethr-seed",
    });
  }

  // --- Routines (heartbeat cadences from the manifest crons) -----------------
  // Helm's daily digest: "what needs you" at 5 PM.
  {
    const digestRoutine = await routines.create(
      companyId,
      {
        title: "Helm daily digest",
        description:
          "Summarize what needs Mark: queue items awaiting review, budget pressure, failed runs.",
        assigneeAgentId: helm.id,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [],
      },
      { userId: "tethr-seed" },
    );
    await routines.createTrigger(
      digestRoutine.id,
      {
        kind: "schedule",
        cronExpression: "0 17 * * *",
        timezone: "America/New_York",
        enabled: true,
        label: "Daily 5:00 PM digest",
      } as never,
      { userId: "tethr-seed" },
    );
  }

  for (const spec of AGENTS) {
    if (!spec.heartbeatCron) continue;
    const agent = agentRowByKey.get(spec.key);
    if (!agent) continue;
    const routine = await routines.create(
      companyId,
      {
        title: `${spec.codename} heartbeat`,
        description: `${spec.heartbeatNote}. Request: ${spec.heartbeatRequest ?? "standing job"}`,
        assigneeAgentId: agent.id,
        priority: "medium",
        status: spec.status === "paused" ? "paused" : "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [],
      },
      { userId: "tethr-seed" },
    );
    await routines.createTrigger(
      routine.id,
      {
        kind: "schedule",
        cronExpression: spec.heartbeatCron,
        timezone: "America/New_York",
        enabled: spec.status !== "paused",
        label: spec.heartbeatNote,
      } as never,
      { userId: "tethr-seed" },
    );
  }

  // --- Reliability division: Sentry, the site auditor (Phase 4) --------------
  // Activates the Reliability shell with a deterministic public-site auditor.
  // Seeded PAUSED: the daily heartbeat stays off until Mark enables it after a
  // reviewed manual run (the phase's approval gate). Findings are internal-only
  // recommendations posted to #scout — never customer-facing content.
  {
    const reliabilityId = divisionByKey.get("reliability") ?? null;
    const sentry = await createAgent({
      key: "sentry",
      name: "Sentry",
      role: "general",
      title: "Site Auditor",
      capabilities:
        "Audit the public travelwithwandr.com surface for technical/SEO issues (meta tags, JSON-LD, broken internal links, GA4/GTM presence) and recommend fixes to #scout. Structural/technical only — never medical-content correctness. Read-only.",
      reportsTo: ceo.id,
      status: "paused",
      pausedReason:
        "Heartbeat off until Mark enables it after a reviewed manual run (Phase 4).",
      budgetMonthlyCents: 2000,
      adapterConfig: { agentTag: "@sentry", heartbeatMode: "site_audit" },
    });
    await db.insert(tethrAgentProfiles).values({
      companyId,
      agentId: sentry.id,
      divisionId: reliabilityId,
      tag: "@sentry",
      codename: "Sentry",
      mission:
        "Keep the public site technically sound: flag missing/over-long meta, missing/malformed JSON-LD, 404 internal links, and missing GA4/GTM tags. Post ≤3 findings/day to #scout in the standard format for a human to route to @Cursor.",
      approvalGate: "internal",
      heartbeatCron: "0 9 * * *",
      heartbeatNote: "Daily 9:00 AM site audit (paused until enabled)",
      portPriority: null,
      routingTable: [],
      standingRules: STANDING_RULES,
    });
    if (reliabilityId) {
      await db
        .update(tethrDivisions)
        .set({ status: "active", headAgentId: sentry.id, updatedAt: new Date() })
        .where(eq(tethrDivisions.id, reliabilityId));
    }
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: sentry.id,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 2000,
      warnPercent: 80,
      hardStopEnabled: true,
      createdByUserId: "tethr-seed",
    });
    const sentryRoutine = await routines.create(
      companyId,
      {
        title: "Sentry heartbeat",
        description: "Daily public-site technical audit; posts ≤3 findings/day to #scout.",
        assigneeAgentId: sentry.id,
        priority: "medium",
        status: "paused",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [],
      },
      { userId: "tethr-seed" },
    );
    await routines.createTrigger(
      sentryRoutine.id,
      {
        kind: "schedule",
        cronExpression: "0 9 * * *",
        timezone: "America/New_York",
        enabled: false,
        label: "Daily 9:00 AM site audit (disabled until enabled)",
      } as never,
      { userId: "tethr-seed" },
    );
  }

  // --- Reliability division: Pulse, the PostHog analytics auditor (Phase 8) --
  // Second Reliability agent, same #scout loop as Sentry. Seeded PAUSED and
  // inert until Mark sets POSTHOG_API_KEY and fills tools/pulse-events.json.
  {
    const reliabilityId = divisionByKey.get("reliability") ?? null;
    const pulse = await createAgent({
      key: "pulse",
      name: "Pulse",
      role: "general",
      title: "Analytics Auditor",
      capabilities:
        "Watch PostHog (project 361561, read-only) for error spikes, dead tracking events, and funnel-conversion drops; recommend fixes to #scout. Marketing analytics only — never person-level or clinical data.",
      reportsTo: ceo.id,
      status: "paused",
      pausedReason:
        "Heartbeat off until Mark sets POSTHOG_API_KEY and fills pulse-events.json (Phase 8).",
      budgetMonthlyCents: 2000,
      adapterConfig: { agentTag: "@pulse", heartbeatMode: "pulse_audit" },
    });
    await db.insert(tethrAgentProfiles).values({
      companyId,
      agentId: pulse.id,
      divisionId: reliabilityId,
      tag: "@pulse",
      codename: "Pulse",
      mission:
        "Flag application-level regressions from analytics: an error type >3× its 7-day baseline, a critical event at 0 for 24h, or a funnel step conversion down >30% day-over-day. Post ≤3 findings/day to #scout for a human to route to @Cursor.",
      approvalGate: "internal",
      heartbeatCron: "0 10 * * *",
      heartbeatNote: "Daily 10:00 AM analytics audit (paused until enabled)",
      portPriority: null,
      routingTable: [],
      standingRules: STANDING_RULES,
    });
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: pulse.id,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 2000,
      warnPercent: 80,
      hardStopEnabled: true,
      createdByUserId: "tethr-seed",
    });
    const pulseRoutine = await routines.create(
      companyId,
      {
        title: "Pulse heartbeat",
        description: "Daily PostHog analytics audit; posts ≤3 findings/day to #scout.",
        assigneeAgentId: pulse.id,
        priority: "medium",
        status: "paused",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [],
      },
      { userId: "tethr-seed" },
    );
    await routines.createTrigger(
      pulseRoutine.id,
      {
        kind: "schedule",
        cronExpression: "0 10 * * *",
        timezone: "America/New_York",
        enabled: false,
        label: "Daily 10:00 AM analytics audit (disabled until enabled)",
      } as never,
      { userId: "tethr-seed" },
    );
  }

  // --- Drive: folders + spec files -------------------------------------------
  const baseFolders = [
    "/agents/helm",
    "/shared",
    "/content/blog",
    "/briefs",
    "/itineraries",
    "/newsroom",
    "/scout/leads",
    "/scout/replies",
    "/scout/news",
    "/ads/recommendations",
    "/analytics",
    "/strategy",
  ];
  for (const folder of baseFolders) {
    await drive.ensureFolder(companyId, folder, "tethr-seed");
  }

  let driveFiles = 0;
  const putSpecFile = async (drivePath: string, content: string, tags: string[]) => {
    await drive.putFile({
      companyId,
      path: drivePath,
      content,
      tags,
      createdByTag: "tethr-seed",
      note: "Imported at seed",
      permissions: { owner: "mark", read: ["*"], write: ["mark", "@helm"] },
    });
    driveFiles++;
  };

  const bundleAgentsDir = bundlePath ? path.join(bundlePath, "agents", "helm") : null;
  if (bundleAgentsDir && fs.existsSync(bundleAgentsDir)) {
    // Import the live bundle markdown (read-only source).
    const walk = (dir: string, prefix: string) => {
      const out: Array<{ abs: string; rel: string }> = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const abs = path.join(dir, entry.name);
        const rel = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) out.push(...walk(abs, rel));
        else if (entry.isFile() && entry.name.endsWith(".md")) out.push({ abs, rel });
      }
      return out;
    };
    for (const file of walk(bundleAgentsDir, "/agents/helm")) {
      const stat = fs.statSync(file.abs);
      if (stat.size > 512 * 1024) continue;
      await putSpecFile(file.rel, fs.readFileSync(file.abs, "utf8"), ["spec", "bundle"]);
    }
    const sharedDir = path.join(bundlePath!, "shared");
    if (fs.existsSync(sharedDir)) {
      for (const entry of fs.readdirSync(sharedDir)) {
        if (!entry.endsWith(".md")) continue;
        await putSpecFile(
          `/shared/${entry}`,
          fs.readFileSync(path.join(sharedDir, entry), "utf8"),
          ["spec", "bundle"],
        );
      }
    }
  } else {
    // Self-contained fallback: generate spec files from the vendored org spec.
    await putSpecFile(
      "/agents/helm/HELM.md",
      `# Helm — Chief Growth Officer\n\n${HELM.mission}\n\n## Standing rules\n${STANDING_RULES.map((r) => `- ${r}`).join("\n")}\n`,
      ["spec", "generated"],
    );
    await putSpecFile(
      "/agents/helm/ROUTING.md",
      `# Helm router\n\n| When the request is about | Route to |\n|---|---|\n${HELM.routing.map((r) => `| ${r.description} | ${r.to} |`).join("\n")}\n`,
      ["spec", "generated"],
    );
    for (const spec of AGENTS) {
      const base = `/agents/helm/${spec.key}`;
      await putSpecFile(
        `${base}/ROLE.md`,
        `# ${spec.codename} — ${spec.role}\n\nTag: @${spec.key}\nReports to: @helm\nGate: ${spec.approvalGate}\nHeartbeat: ${spec.heartbeatNote}\n\n${spec.mission}\n`,
        ["spec", "generated"],
      );
      await putSpecFile(
        `${base}/ROUTING.md`,
        `# ${spec.codename} router\n\n| When | Route to |\n|---|---|\n${spec.routing.map((r) => `| ${r.when.join(", ")} | ${r.to} |`).join("\n")}\n`,
        ["spec", "generated"],
      );
      for (const sub of spec.subagents) {
        await putSpecFile(
          `${base}/subagents/${sub.key}.md`,
          [
            `# @${spec.key}.${sub.key} — ${sub.name}`,
            ``,
            `**Job.** ${sub.job}`,
            ``,
            `**Route here when:** ${sub.routeWhen.join("; ")}`,
            ``,
            `**Reads:**\n${sub.reads.map((r) => `- ${r}`).join("\n")}`,
            ``,
            `**Steps:**\n${sub.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
            ``,
            `**Output.** ${sub.output}`,
            ``,
            `**Guardrails:**\n${sub.guardrails.map((g) => `- ${g}`).join("\n")}`,
            ``,
            `**Done =** ${sub.doneWhen}`,
            ``,
            `**Escalation.** ${sub.escalation}`,
          ].join("\n"),
          ["spec", "generated"],
        );
      }
    }
    await putSpecFile(
      "/shared/CLAUDE.md",
      `# Wandr Growth — company memory\n\n${COMPANY.goal}\n\n## Standing rules\n${STANDING_RULES.map((r) => `- ${r}`).join("\n")}\n`,
      ["spec", "generated"],
    );
  }

  // --- Working state: trackers in /state ---------------------------------------
  const trackers = trackerService(db);
  for (const [name, rows] of Object.entries(STATE_SEEDS)) {
    await trackers.writeTracker(
      companyId,
      {
        name: name as keyof typeof STATE_SEEDS,
        rows: rows.map((r) => ({ ...r, status: "idea" as const })),
      },
      "tethr-seed",
      "Seeded from the bundle calendars",
    );
    driveFiles++;
  }

  // --- Memories ---------------------------------------------------------------
  for (const m of COMPANY_MEMORIES) {
    await memory.record({ companyId, kind: m.kind, content: m.content, source: "seed" });
  }

  // --- Goal + project + issues (task board) ------------------------------------
  const [goal] = await db
    .insert(goals)
    .values({
      companyId,
      title: "Grow qualified traffic + revenue within sustainable unit economics",
      description: COMPANY.goal,
      level: "company",
      status: "active",
      ownerAgentId: helm.id,
    })
    .returning();
  const [project] = await db
    .insert(projects)
    .values({
      companyId,
      name: "Growth engine",
      description:
        "The standing growth machine: daily content, nightly briefs, itineraries, scout, ads, analytics.",
      status: "active",
    })
    .returning();

  const issueSeed: Array<{
    title: string;
    status: string;
    priority: string;
    agentKey: string | null;
    description: string;
    parentIndex?: number;
  }> = [
    {
      title: "Prove the Sonar loop end-to-end with the human send gate",
      status: "in_progress",
      priority: "high",
      agentKey: "sonar",
      description:
        "Heartbeat → leads scan → reply draft → gated review in the Queue → human approves → human posts. First port per the handoff.",
    },
    {
      title: "Re-point content pipeline at the Drive (replace Google Drive)",
      status: "todo",
      priority: "high",
      agentKey: "atlas",
      description: "Drafts land in /content/blog with versions + tags; review flow stays gated.",
    },
    {
      title: "Locate or rebuild the wandr-destination-brief skill",
      status: "blocked",
      priority: "high",
      agentKey: "compass",
      description:
        "Missing from the account per skills/README.md. Compass's nightly brief depends on it. Blocked on Mark confirming whether it's recoverable.",
    },
    {
      title: "Confirm Google Ads MCP + Chrome can run hosted/headless",
      status: "todo",
      priority: "medium",
      agentKey: "tailwind",
      description:
        "Both are laptop-bound today. Until confirmed, Tailwind stays recommendation-only with hard spend gates.",
    },
    {
      title: "Set per-agent budget caps before go-live",
      status: "done",
      priority: "medium",
      agentKey: "ledger",
      description: "Caps seeded: Helm holds the combined growth line; Tailwind hard-stops.",
    },
    {
      title: "Weekly GA4 dashboard refresh on the new analytics path",
      status: "in_review",
      priority: "low",
      agentKey: "ledger",
      description: "Rolling 30d metrics into /analytics with the Sunday heartbeat.",
    },
  ];
  let issueNumber = 0;
  const issueIds: string[] = [];
  for (const item of issueSeed) {
    issueNumber++;
    const agent = item.agentKey ? agentRowByKey.get(item.agentKey) : null;
    const [issue] = await db
      .insert(issues)
      .values({
        companyId,
        projectId: project.id,
        goalId: goal.id,
        parentId: item.parentIndex !== undefined ? issueIds[item.parentIndex] : null,
        title: item.title,
        description: item.description,
        status: item.status,
        priority: item.priority,
        assigneeAgentId: agent?.id ?? null,
        createdByUserId: "tethr-seed",
        issueNumber,
        identifier: `${COMPANY.issuePrefix}-${issueNumber}`,
      })
      .returning();
    issueIds.push(issue.id);
  }
  await db
    .update(companies)
    .set({ issueCounter: issueNumber })
    .where(eq(companies.id, companyId));

  const demoCounters = { routeRuns: 0, decided: 0, heartbeatRuns: 0, costEvents: 0, issues: issueSeed.length };

  if (demo) {
    // --- Backdated heartbeat run history -----------------------------------
    const cronAgents = AGENTS.filter((a) => a.heartbeatCron);
    for (const spec of cronAgents) {
      const agent = agentRowByKey.get(spec.key);
      if (!agent) continue;
      const days = spec.heartbeatCron === "0 0 * * 0" ? [1, 8] : [1, 2, 3, 4, 5];
      for (const daysAgo of days) {
        const started = new Date(Date.now() - daysAgo * 24 * 3600 * 1000);
        started.setHours(spec.key === "voyager" ? 1 : spec.key === "compass" ? 22 : 21, 5, 0, 0);
        const failed = spec.key === "voyager" && daysAgo === 3;
        const durationMs = Math.floor(40_000 + rand() * 90_000);
        await db.insert(heartbeatRuns).values({
          companyId,
          agentId: agent.id,
          invocationSource: "timer",
          triggerDetail: `${spec.codename} heartbeat (${spec.heartbeatCron})`,
          status: failed ? "failed" : "succeeded",
          startedAt: started,
          finishedAt: new Date(started.getTime() + durationMs),
          exitCode: failed ? 1 : 0,
          error: failed ? "Featured-image dedupe check failed; retried on next heartbeat." : null,
          resultJson: failed
            ? null
            : { summary: `${spec.codename} heartbeat completed — output staged.` },
          usageJson: {
            inputTokens: Math.floor(2000 + rand() * 4000),
            outputTokens: Math.floor(900 + rand() * 2400),
          },
          stdoutExcerpt: failed
            ? "[tethr] image dedupe: candidate already used by peru-altitude-guide\n"
            : `[tethr] ${spec.codename} heartbeat — output staged for review\n`,
          createdAt: started,
          updatedAt: new Date(started.getTime() + durationMs),
        });
        demoCounters.heartbeatRuns++;
      }
    }

    // --- Backdated cost events over 30 days ---------------------------------
    const weights: Record<string, number> = {
      atlas: 1.0,
      compass: 0.7,
      voyager: 0.8,
      sonar: 0.25,
      tailwind: 1.6,
      ledger: 0.4,
      herald: 0.2,
      beacon: 0.3,
    };
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const spentByAgent = new Map<string, number>();
    for (const spec of AGENTS) {
      const agent = agentRowByKey.get(spec.key);
      if (!agent) continue;
      for (let daysAgo = 29; daysAgo >= 1; daysAgo--) {
        const w = weights[spec.key] ?? 0.5;
        if (rand() > Math.min(0.92, 0.35 + w * 0.4)) continue;
        const occurredAt = new Date(Date.now() - daysAgo * 24 * 3600 * 1000);
        occurredAt.setHours(Math.floor(rand() * 23), Math.floor(rand() * 59), 0, 0);
        const costCents = Math.max(4, Math.round((30 + rand() * 240) * w));
        await db.insert(costEvents).values({
          companyId,
          agentId: agent.id,
          provider: "anthropic",
          biller: "anthropic",
          billingType: "api",
          model: "claude-sonnet-4-6",
          inputTokens: costCents * 90,
          outputTokens: costCents * 28,
          costCents,
          occurredAt,
          createdAt: occurredAt,
        });
        demoCounters.costEvents++;
        if (occurredAt >= monthStart) {
          spentByAgent.set(spec.key, (spentByAgent.get(spec.key) ?? 0) + costCents);
        }
      }
    }
    let companySpent = 0;
    for (const [key, spent] of spentByAgent) {
      const agent = agentRowByKey.get(key);
      if (!agent) continue;
      companySpent += spent;
      await db.update(agents).set({ spentMonthlyCents: spent }).where(eq(agents.id, agent.id));
    }
    await db
      .update(companies)
      .set({ spentMonthlyCents: companySpent })
      .where(eq(companies.id, companyId));

    // --- Live demo traffic through the real routing engine ------------------
    const demoRequests = [
      "Write today's blog post on altitude sickness prevention for Cusco travelers",
      "Draft a reply to the Reddit thread asking about typhoid and malaria prep for Tanzania",
      "Any travel health news today worth writing about?",
      "How are ads doing this week against our guardrails?",
      "Can we afford to spend more on the Peru campaign? What's our max CAC?",
      "Press release: Wandr partners with Andean Trails for health-ready trekking itineraries",
      "Adjust bids to scale the Peru search campaign by 20%",
      "Draft tonight's destination brief",
    ];
    const routeResults = [];
    for (const request of demoRequests) {
      const result = await routing.routeRequest({
        companyId,
        requestText: request,
        invocationSource: "console",
        requestedByUserId: "mark",
      });
      routeResults.push(result);
      demoCounters.routeRuns++;
    }

    // Decide a couple of gated outputs so the audit trail shows real history.
    const gatedOutputs = routeResults
      .flatMap((r) => r.outputs)
      .filter((o) => o.gated);
    const blogOutput = gatedOutputs.find((o) => o.title.toLowerCase().includes("altitude"));
    if (blogOutput) {
      await gating.decide({
        companyId,
        outputId: blogOutput.outputId,
        decision: "approve",
        reviewer: "mark",
        note: "Clinically reviewed — altitude guidance matches the catalog protocol. Ship it.",
      });
      demoCounters.decided++;
    }
    const bidsOutput = routeResults
      .flatMap((r) => r.outputs)
      .find((o) => o.gated && o.title.toLowerCase().includes("ads recommendation"));
    if (bidsOutput && bidsOutput.outputId !== blogOutput?.outputId) {
      await gating.decide({
        companyId,
        outputId: bidsOutput.outputId,
        decision: "reject",
        reviewer: "mark",
        note: "Hold until the next unit-economics refresh — CAC headroom is too thin this month.",
      });
      demoCounters.decided++;
    }

    await notify.send({
      companyId,
      kind: "budget",
      title: "Tailwind at 68% of its monthly cap",
      body: "Hard stop is enabled for the ads budget. Ledger refreshes guardrails Sunday.",
      href: "/budgets",
      agentTag: "@tailwind",
    });
  }

  // Update sequence-sensitive counters and finish.
  await db
    .update(companies)
    .set({ updatedAt: new Date() })
    .where(eq(companies.id, companyId));

  logger.info(
    { companyId, agents: agentRowByKey.size + 2, subagents: subagentCount },
    "[tethr] Wandr Growth seeded",
  );

  return {
    companyId,
    created: true,
    agents: agentRowByKey.size + 2,
    subagents: subagentCount,
    divisions: DIVISIONS.length,
    driveFiles,
    demo: demoCounters,
  };
}

/**
 * Auto-seed hook used at server startup (TETHR_AUTOSEED=false disables).
 * Phase 11: the default org is the clean slate — one coordinator agent,
 * @tethr — seeded by tethr-core.ts. The full Wandr Growth org above is kept
 * as the parts bin for re-adding specialists (POST /api/tethr/seed {"org":"growth"}).
 */
export async function maybeAutoSeed(db: Db): Promise<void> {
  if (process.env.TETHR_AUTOSEED === "false") return;
  if (process.env.VITEST || process.env.NODE_ENV === "test") return;
  try {
    const { seedTethrCore } = await import("./tethr-core.js");
    const result = await seedTethrCore(db);
    if (result.created || result.archivedOldCompany) {
      logger.info(
        { companyId: result.companyId, created: result.created, archivedOldCompany: result.archivedOldCompany },
        "[tethr] auto-seeded the clean-slate org (@tethr)",
      );
    }
  } catch (err) {
    logger.error({ err }, "[tethr] auto-seed failed");
  }
}
