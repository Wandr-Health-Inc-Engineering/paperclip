import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tethrOutputs, tethrRouteRuns } from "@paperclipai/db";
import { logFailure } from "../best-effort.js";
import { MINUTE, SECOND } from "../time.js";

// Waiting for a chat turn the server started itself (a scheduled rhythm item,
// an agent's task, an idea check): poll its row until it finishes, and stop it
// if it runs past its time, so the caller's result and the chat agree.

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

export interface ChatTaskResult {
  /** skipped = agents were paused when the turn's time came; nothing ran. */
  status: "done" | "failed" | "skipped";
  text: string;
  runId: string | null;
  outputs: Array<{ outputId: string; title: string; status: string; gated: boolean }>;
}

/** The outputs (files, approval cards) a turn produced. */
export async function turnOutputs(db: Db, runId: string): Promise<ChatTaskResult["outputs"]> {
  const rows = await db
    .select({ id: tethrOutputs.id, title: tethrOutputs.title, status: tethrOutputs.status })
    .from(tethrOutputs)
    .where(eq(tethrOutputs.routeRunId, runId));
  return rows.map((o) => ({ outputId: o.id, title: o.title, status: o.status, gated: o.status === "gated" || o.status === "changes_requested" }));
}

/** How a turn tethr started for a task ended. A turn the usage throttle answered
 * is "skipped": nothing ran. `chatName` says where the partial work is. */
export function chatTaskResult(
  row: TurnRow | undefined,
  run: { runId: string; timedOut: boolean; waitMs: number; outputs: ChatTaskResult["outputs"]; chatName?: string },
): ChatTaskResult {
  const base = { runId: run.runId, outputs: run.outputs };
  if (wasSkippedByThrottle(row)) return { ...base, status: "skipped", text: "Skipped: agents were paused when this was due." };
  if (row?.status === "done") return { ...base, status: "done", text: row.resultText || "Done." };
  if (run.timedOut) {
    const minutes = Math.max(1, Math.round(run.waitMs / MINUTE));
    return { ...base, status: "failed", text: `Took longer than ${minutes} minutes, so it was stopped. What it did so far is in ${run.chatName ?? "the Operations chat"}.` };
  }
  return { ...base, status: "failed", text: row?.error || "The scheduled turn didn't finish." };
}
