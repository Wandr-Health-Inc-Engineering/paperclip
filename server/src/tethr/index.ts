import type { Db } from "@paperclipai/db";
import { initTethrAdapter } from "./adapter.js";

export { tethrRoutes } from "../routes/tethr.js";
export { initTethrAdapter } from "./adapter.js";
export { routingService } from "./routing.js";
export { gatingService } from "./gating.js";
export { driveService } from "./drive.js";
export { memoryService } from "./memory.js";
export { notificationService } from "./notify.js";
export { orgService } from "./org.js";
export { workerService } from "./worker.js";
export { getTethrLLMProvider, setTethrLLMProvider } from "./llm/index.js";

/**
 * One-call Tethr bootstrap, invoked from createApp (the only core touchpoint
 * besides the route mount). Registers the tethr_llm adapter. Auto-seeding is
 * a server-startup concern (index.ts), kept out of createApp so API tests
 * that build an app never seed a company as a side effect.
 */
export function initTethr(db: Db): void {
  initTethrAdapter(db);
}

/**
 * Startup auto-seed. The seed module is loaded lazily (and never under test)
 * so core tests that mock @paperclipai/db with a partial export list are not
 * forced to know about every table the seeder touches.
 */
export async function maybeAutoSeed(db: Db): Promise<void> {
  if (process.env.VITEST || process.env.NODE_ENV === "test") return;
  const seed = await import("./seed/seed.js");
  await seed.maybeAutoSeed(db);
  await reapOrphanedRouteRuns(db);
  await healInboxApprovedOutputs(db);
  const { healTethrRoutingCopy, healSystemAgentParents } = await import("./seed/tethr-core.js");
  await healTethrRoutingCopy(db);
  await healSystemAgentParents(db);
  // Start Slack Socket Mode if configured (SLACK_APP_TOKEN) — lets tag/DM reach
  // a local server with no public URL. No-op when the token is unset.
  const { startSlackSocketMode } = await import("./slack.js");
  void startSlackSocketMode(db);
}

/**
 * A route run only makes progress inside a live process. Any run still in
 * `routing`/`working` at boot was interrupted by a restart or crash (the
 * subscription backend's slow multi-hop runs are especially exposed to this), so
 * it would otherwise hang forever at "working" in the Console. Mark such runs
 * failed with a clear reason. Best-effort — never blocks boot.
 */
/**
 * Heal outputs approved through the (now retired) core Inbox. Its Approve
 * button flipped the core `approvals` row to "approved" without ever calling
 * gating.decide — so the human's decision landed in the DB but the output
 * stayed "gated" and never published/applied. Re-run the decision through the
 * real path. Idempotent: a healed output leaves "gated", so it never matches
 * again. Best-effort — never blocks boot.
 */
async function healInboxApprovedOutputs(db: Db): Promise<void> {
  try {
    const { approvals, tethrOutputs } = await import("@paperclipai/db");
    const { and, eq, isNotNull } = await import("drizzle-orm");
    const desynced = await db
      .select({ id: tethrOutputs.id, companyId: tethrOutputs.companyId, title: tethrOutputs.title })
      .from(tethrOutputs)
      .innerJoin(approvals, eq(approvals.id, tethrOutputs.approvalId))
      .where(
        and(
          eq(tethrOutputs.status, "gated"),
          isNotNull(tethrOutputs.approvalId),
          eq(approvals.status, "approved"),
        ),
      );
    if (!desynced.length) return;
    const { gatingService } = await import("./gating.js");
    const { logger } = await import("../middleware/logger.js");
    const gating = gatingService(db);
    for (const output of desynced) {
      try {
        await gating.decide({
          companyId: output.companyId,
          outputId: output.id,
          decision: "approve",
          reviewer: "reconciler:inbox-heal",
          note: "Approved earlier via the core Inbox (which never applied); re-run through gating.",
        });
        logger.info({ outputId: output.id, title: output.title }, "tethr: healed inbox-approved output");
      } catch (err) {
        logger.warn({ err, outputId: output.id }, "tethr: inbox-heal failed for output");
      }
    }
  } catch {
    // best-effort cleanup — a failure here must not block startup
  }
}

async function reapOrphanedRouteRuns(db: Db): Promise<void> {
  try {
    const { tethrRouteRuns } = await import("@paperclipai/db");
    const { inArray } = await import("drizzle-orm");
    const reaped = await db
      .update(tethrRouteRuns)
      .set({
        status: "failed",
        error: "Interrupted — the server restarted while this run was in progress.",
        updatedAt: new Date(),
      })
      .where(inArray(tethrRouteRuns.status, ["routing", "working"]))
      .returning({ id: tethrRouteRuns.id });
    if (reaped.length) {
      const { logger } = await import("../middleware/logger.js");
      logger.info({ count: reaped.length }, "tethr: reaped orphaned route runs at boot");
    }
  } catch {
    // best-effort cleanup — a failure here must not block startup
  }
}
