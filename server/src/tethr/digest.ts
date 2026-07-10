import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, tethrOutputs } from "@paperclipai/db";
import { gatingService } from "./gating.js";
import { notificationService } from "./notify.js";
import { orgService } from "./org.js";

// The daily digest: Helm's "what needs you" summary. Queue items, budget
// pressure, failed runs — one internal output + one notification, on a
// schedule or on demand.

export function digestService(db: Db) {
  const org = orgService(db);
  const gating = gatingService(db);
  const notify = notificationService(db);

  async function generateDigest(companyId: string): Promise<{
    outputId: string;
    title: string;
    pendingCount: number;
  }> {
    const helm = await org.getProfileByTag(companyId, "@helm");
    if (!helm) throw new Error("Helm is not seeded");

    const pending = await db
      .select()
      .from(tethrOutputs)
      .where(
        and(
          eq(tethrOutputs.companyId, companyId),
          inArray(tethrOutputs.status, ["gated", "changes_requested"]),
        ),
      )
      .orderBy(desc(tethrOutputs.createdAt))
      .limit(20);

    const profiles = await org.listProfiles(companyId);
    const hotAgents = profiles.filter(
      ({ agent }) =>
        agent.budgetMonthlyCents > 0 &&
        agent.spentMonthlyCents / agent.budgetMonthlyCents >= 0.8,
    );

    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);
    const failedRuns = await db
      .select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, error: heartbeatRuns.error })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.status, "failed"),
          gte(heartbeatRuns.createdAt, dayAgo),
        ),
      )
      .limit(10);
    const agentNameById = new Map(profiles.map((p) => [p.agent.id, p.agent.name]));

    const date = new Date().toISOString().slice(0, 10);
    const lines: string[] = [
      `## What needs you — ${date}`,
      "",
      `**Queue: ${pending.length} item${pending.length === 1 ? "" : "s"} awaiting review.**`,
      ...pending
        .slice(0, 8)
        .map(
          (o) =>
            `- [${o.sensitivity}] ${o.title} — ${(o.meta as Record<string, unknown>)?.agentTag ?? ""}`,
        ),
      "",
    ];
    if (hotAgents.length) {
      lines.push("**Budget pressure:**");
      for (const { agent, profile } of hotAgents) {
        const pct = Math.round((agent.spentMonthlyCents / agent.budgetMonthlyCents) * 100);
        lines.push(`- ${profile.tag} at ${pct}% of its monthly cap`);
      }
      lines.push("");
    }
    if (failedRuns.length) {
      lines.push("**Failed runs (24h):**");
      for (const run of failedRuns) {
        lines.push(
          `- ${agentNameById.get(run.agentId) ?? run.agentId}: ${(run.error ?? "unknown error").slice(0, 120)}`,
        );
      }
      lines.push("");
    }
    if (!pending.length && !hotAgents.length && !failedRuns.length) {
      lines.push("Nothing needs you. The crew is on schedule.");
    }

    const output = await gating.createOutput({
      companyId,
      agentId: helm.agent.id,
      agentTag: "@helm",
      kind: "document",
      title: `Daily digest — ${date}`,
      body: lines.join("\n"),
      sensitivity: "internal",
      meta: { digest: true },
    });
    if (!output) throw new Error("Digest output failed");

    await notify.send({
      companyId,
      kind: "system",
      title: `Daily digest: ${pending.length} in the queue${hotAgents.length ? `, ${hotAgents.length} budget warning${hotAgents.length === 1 ? "" : "s"}` : ""}`,
      body: failedRuns.length ? `${failedRuns.length} failed run(s) in the last 24h.` : undefined,
      href: `/queue`,
      agentTag: "@helm",
    });

    return { outputId: output.id, title: output.title, pendingCount: pending.length };
  }

  // Phase 9: weekly spend summary — total + per-agent spend vs cap, to #scout.
  async function generateWeeklySummary(
    companyId: string,
  ): Promise<{ totalSpentCents: number; agents: number }> {
    const profiles = await org.listProfiles(companyId);
    const spenders = profiles
      .filter((p) => p.agent.budgetMonthlyCents > 0)
      .sort((a, b) => b.agent.spentMonthlyCents - a.agent.spentMonthlyCents);
    const totalSpentCents = spenders.reduce((s, p) => s + p.agent.spentMonthlyCents, 0);
    const date = new Date().toISOString().slice(0, 10);
    const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;
    const lines: string[] = [
      `## Weekly spend summary — ${date}`,
      "",
      `**Total this month: ${dollars(totalSpentCents)}**`,
      "",
      "**Per agent (spend / cap):**",
      ...spenders.map((p) => {
        const pct =
          p.agent.budgetMonthlyCents > 0
            ? Math.round((p.agent.spentMonthlyCents / p.agent.budgetMonthlyCents) * 100)
            : 0;
        return `- ${p.profile.tag}: ${dollars(p.agent.spentMonthlyCents)} / ${dollars(p.agent.budgetMonthlyCents)} (${pct}%)${pct >= 80 ? " — over 80% cap" : ""}`;
      }),
    ];
    const helm = await org.getProfileByTag(companyId, "@helm");
    if (helm) {
      await gating.createOutput({
        companyId,
        agentId: helm.agent.id,
        agentTag: "@helm",
        kind: "document",
        title: `Weekly spend summary — ${date}`,
        body: lines.join("\n"),
        sensitivity: "internal",
        meta: { weeklySummary: true },
      });
    }
    await notify.send({
      companyId,
      kind: "budget",
      title: `Weekly spend: ${dollars(totalSpentCents)} across ${spenders.length} agents`,
      body: lines.slice(4).join("\n"),
      href: `/budgets`,
      agentTag: "@helm",
    });
    return { totalSpentCents, agents: spenders.length };
  }

  return { generateDigest, generateWeeklySummary };
}

export type DigestService = ReturnType<typeof digestService>;
