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

// Startup auto-seed lives in boot.ts: server startup imports it from there, so
// it doesn't load the whole engine (and every table it touches) just to boot.
export { maybeAutoSeed } from "./boot.js";
