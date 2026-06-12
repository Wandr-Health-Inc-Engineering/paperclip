import type { Db } from "@paperclipai/db";
import { initTethrAdapter } from "./adapter.js";
import { maybeAutoSeed } from "./seed/seed.js";

export { tethrRoutes } from "../routes/tethr.js";
export { initTethrAdapter } from "./adapter.js";
export { seedWandrGrowth, maybeAutoSeed } from "./seed/seed.js";
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
 * besides the route mount). Registers the tethr_llm adapter and kicks the
 * auto-seed check in the background.
 */
export function initTethr(db: Db): void {
  initTethrAdapter(db);
  void maybeAutoSeed(db);
}
