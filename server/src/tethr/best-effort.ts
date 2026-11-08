import { logger } from "../middleware/logger.js";

/**
 * For work that must never fail the caller (a bell notification, an activity
 * log line): `.catch(logFailure("idea bell"))` keeps going but leaves a warning,
 * instead of swallowing the error silently.
 */
export function logFailure(what: string, context: Record<string, unknown> = {}) {
  return (err: unknown): void => {
    logger.warn({ err, ...context }, `[tethr] ${what} failed`);
  };
}
