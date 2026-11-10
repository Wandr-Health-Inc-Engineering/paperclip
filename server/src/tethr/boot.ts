import type { Db } from "@paperclipai/db";

// Tethr's startup work (auto-seed, boot heals, Slack Socket Mode), imported by
// server startup (src/index.ts). Keep this module's top level free of static
// imports beyond types: everything loads lazily inside maybeAutoSeed, so core
// tests that mock @paperclipai/db with a partial export list can import the
// server entry without knowing every table Tethr touches.

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
  // Phase 27: team agents made before icons followed the job.
  const { healTeamIcons } = await import("./team.js");
  await healTeamIcons(db).catch(() => 0);
  // The goals interview now runs in the main chat; fold an older side-chat one in.
  const { foldInterviewsIntoMainChats } = await import("./main-chat.js");
  await foldInterviewsIntoMainChats(db).catch(() => {});
  // Start Slack Socket Mode if configured (SLACK_APP_TOKEN) — lets tag/DM reach
  // a local server with no public URL. No-op when the token is unset.
  const { startSlackSocketMode } = await import("./slack.js");
  void startSlackSocketMode(db);
  // Phase 21: watch Slack conversations, goals and quiet stretches for ideas.
  const { startWatch } = await import("./watch.js");
  startWatch(db);
  // Phase 24: tethr acts on its own (check-ins, daily review) once switched on.
  const { startBrain } = await import("./team-brain.js");
  startBrain(db);
  // Phase 25: past chat turns into Hermes (only for companies that use it).
  const { startMemoryIndexer } = await import("./hermes/indexer.js");
  startMemoryIndexer(db);
  // Phase 26.3: tethr's Inbox (the Drive's 00 Inbox folder), once a minute.
  const { startInboxWatcher } = await import("./inbox/pipeline.js");
  startInboxWatcher(db);
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
      .where(inArray(tethrRouteRuns.status, ["routing", "working", "queued", "running"]))
      .returning({ id: tethrRouteRuns.id });
    if (reaped.length) {
      const { logger } = await import("../middleware/logger.js");
      logger.info({ count: reaped.length }, "tethr: reaped orphaned route runs at boot");
    }
  } catch {
    // best-effort cleanup — a failure here must not block startup
  }
}
