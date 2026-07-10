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
  // Start Slack Socket Mode if configured (SLACK_APP_TOKEN) — lets tag/DM reach
  // a local server with no public URL. No-op when the token is unset.
  const { startSlackSocketMode } = await import("./slack.js");
  void startSlackSocketMode(db);
}
