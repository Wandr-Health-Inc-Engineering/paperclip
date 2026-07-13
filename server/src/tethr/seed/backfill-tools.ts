import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { budgetPolicies, tethrSubagents } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";

// One-time heal for factory agents created before the per-subagent tool grant
// (migration 0093) was wired through. Those agents got baseline-only tools at
// run time (drive/memory/escalate) and could never fetch anything — a
// "market research" agent that couldn't research. New factory agents now get
// their CEO-chosen kit persisted at creation; this only fills in the ones that
// predate that. Idempotent: once tools is non-null it is never overwritten.

// The research-only default. Every entry is read-only (a subset of the factory's
// PROPOSABLE_TOOLS) — nothing here writes or publishes. A market-research agent
// wants the full read kit: public web, Reddit chatter, CDC/WHO notices, and real
// search-volume data.
const RESEARCH_DEFAULT = ["web_fetch", "reddit_scan", "cdc_scan", "keyword_ideas"];

/**
 * Grant the research default to any factory-born subagent whose tools grant is
 * still NULL. Factory agents are identified precisely by their budget policy
 * author ("tethr-factory") — seeded agents ("tethr-seed") are never touched and
 * keep falling back to the static allowlist. Returns the number of subagents healed.
 */
export async function backfillFactoryAgentTools(
  db: Db,
  companyId: string,
): Promise<number> {
  const factoryAgentIds = (
    await db
      .select({ id: budgetPolicies.scopeId })
      .from(budgetPolicies)
      .where(
        and(
          eq(budgetPolicies.companyId, companyId),
          eq(budgetPolicies.scopeType, "agent"),
          eq(budgetPolicies.createdByUserId, "tethr-factory"),
        ),
      )
  )
    .map((r) => r.id)
    .filter((x): x is string => Boolean(x));
  if (!factoryAgentIds.length) return 0;

  const updated = await db
    .update(tethrSubagents)
    .set({ tools: RESEARCH_DEFAULT })
    .where(
      and(
        eq(tethrSubagents.companyId, companyId),
        isNull(tethrSubagents.tools),
        inArray(tethrSubagents.agentId, factoryAgentIds),
      ),
    )
    .returning({ tag: tethrSubagents.tag });

  if (updated.length) {
    logger.info(
      { companyId, granted: updated.map((u) => u.tag), tools: RESEARCH_DEFAULT },
      "[tethr] backfilled research tools onto pre-0093 factory agents",
    );
  }
  return updated.length;
}
