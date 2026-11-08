import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tethrRouteRuns } from "@paperclipai/db";
import { logFailure } from "../best-effort.js";
import { SECOND } from "../time.js";

// Waiting for a chat turn the server started itself (a scheduled rhythm item,
// an idea check): poll its row until it finishes, and stop it if it runs past
// its time, so the caller's result and the chat agree.

export type TurnRow = typeof tethrRouteRuns.$inferSelect;

const FINISHED = new Set(["done", "failed", "stopped"]);

export const isFinished = (row: TurnRow | undefined): boolean => !!row && FINISHED.has(row.status);

/** A turn the usage throttle answered with its canned "paused" reply: nothing actually ran. */
export const wasSkippedByThrottle = (row: TurnRow | undefined): boolean => row?.status === "done" && row.llmProvider === "throttle";

export interface WaitOptions {
  /** How long the turn may take, queue included. */
  waitMs: number;
  pollMs?: number;
  /** After stopping an overdue turn, how long to wait for it to wind down. */
  stopGraceMs?: number;
}

export async function waitForTurn(db: Db, runId: string, options: WaitOptions): Promise<{ row: TurnRow | undefined; timedOut: boolean }> {
  const pollMs = options.pollMs ?? 2 * SECOND;
  const read = async () => (await db.select().from(tethrRouteRuns).where(eq(tethrRouteRuns.id, runId)))[0];
  const pollUntil = async (deadline: number, row: TurnRow | undefined) => {
    let current = row;
    while (current && !isFinished(current) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      current = await read();
    }
    return current;
  };

  let row = await pollUntil(Date.now() + options.waitMs, await read());
  if (!row || isFinished(row)) return { row, timedOut: false };

  const { getAssistantRunner } = await import("./runner.js");
  await getAssistantRunner(db).stop(runId).catch(logFailure("stopping an overdue turn", { runId }));
  row = await pollUntil(Date.now() + (options.stopGraceMs ?? 30 * SECOND), row);
  return { row, timedOut: true };
}
