// Self-observability for the Tethr server (Phase 9). Turns silent failures into
// a throttled #scout alert (via the existing Notifier — Slack only fires with a
// token) and exposes a deep health check for an external uptime pinger.
//
// The daily Helm digest already summarizes failed runs + budget pressure; this
// adds *within-minutes* alerting on the error classes that matter, throttled so
// a flapping failure can't spam the channel.

import { desc, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { notificationService } from "./notify.js";

const THROTTLE_MS = 60 * 60 * 1000; // max one alert per error class per hour
const lastSent = new Map<string, number>();

/** True if this error class hasn't alerted within the throttle window (records the send). */
export function shouldAlert(errorClass: string, now = Date.now(), throttleMs = THROTTLE_MS): boolean {
  const prev = lastSent.get(errorClass);
  if (prev !== undefined && now - prev < throttleMs) return false;
  lastSent.set(errorClass, now);
  return true;
}

/** Test-only: clear the throttle state. */
export function __resetAlertThrottle(): void {
  lastSent.clear();
}

/** Report a server error to #scout, throttled by class. Never throws. */
export async function reportServerError(
  db: Db,
  companyId: string,
  input: { errorClass: string; message: string; agentTag?: string },
): Promise<boolean> {
  if (!shouldAlert(input.errorClass)) return false;
  try {
    await notificationService(db).send({
      companyId,
      kind: "system",
      title: `Tethr alert: ${input.errorClass}`,
      body: input.message.slice(0, 500),
      agentTag: input.agentTag ?? "@system",
    });
    return true;
  } catch (err) {
    logger.warn({ err }, "tethr observability: failed to report error");
    return false;
  }
}

export interface DeepHealth {
  ok: boolean;
  db: boolean;
  lastHeartbeatAgeSec: number | null;
  checkedAt: string;
}

/** Deep health: DB reachable + age of the most recent heartbeat run. */
export async function deepHealthCheck(db: Db): Promise<DeepHealth> {
  let dbOk = false;
  try {
    await db.execute(sql`select 1`);
    dbOk = true;
  } catch {
    dbOk = false;
  }
  let lastHeartbeatAgeSec: number | null = null;
  if (dbOk) {
    try {
      const [row] = await db
        .select({ createdAt: heartbeatRuns.createdAt })
        .from(heartbeatRuns)
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(1);
      if (row?.createdAt) {
        lastHeartbeatAgeSec = Math.round((Date.now() - new Date(row.createdAt).getTime()) / 1000);
      }
    } catch {
      // heartbeat age is best-effort; DB reachability is the primary signal
    }
  }
  return { ok: dbOk, db: dbOk, lastHeartbeatAgeSec, checkedAt: new Date().toISOString() };
}
