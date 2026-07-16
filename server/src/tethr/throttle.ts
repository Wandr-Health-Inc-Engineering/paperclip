import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

// A global per-company "agents paused" switch — the usage throttle. When paused,
// every heartbeat and every routed request (Console / Slack / CLI / API) skips
// all LLM work and returns a short "paused" note instead. It's the operator's
// kill switch for subscription usage: flip it from the Tethr UI or from Slack
// ("pause agents" / "resume agents") when you're near your Claude limits.
//
// Stored as human-owned local config in the instance dir (same pattern as the
// overseer roster / drive mounts), so it survives restarts and no agent can flip
// it. Read is sync + cheap (tiny file), so the hot-path checks stay fast.

export interface ThrottleState {
  paused: boolean;
  reason?: string;
  /** ISO timestamp of the last change. */
  at?: string;
  /** Who flipped it (actor id / "slack" / tag). */
  by?: string;
}

interface ThrottleFile {
  [companyId: string]: ThrottleState;
}

function configPath(): string {
  if (process.env.TETHR_PAUSED_FILE) return process.env.TETHR_PAUSED_FILE;
  return path.resolve(resolvePaperclipInstanceRoot(), "tethr-paused.json");
}

function readFile(): ThrottleFile {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as ThrottleFile) : {};
  } catch {
    return {};
  }
}

async function writeFile(data: ThrottleFile): Promise<void> {
  const file = configPath();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

/** Fast hot-path check used by routing + the heartbeat adapter. */
export function isAgentsPaused(companyId: string): boolean {
  return readFile()[companyId]?.paused === true;
}

/** Full state for the UI / status. */
export function getThrottleState(companyId: string): ThrottleState {
  return readFile()[companyId] ?? { paused: false };
}

/** Flip the switch. Returns the new state. */
export async function setThrottle(
  companyId: string,
  paused: boolean,
  opts: { reason?: string; by?: string } = {},
): Promise<ThrottleState> {
  const data = readFile();
  const state: ThrottleState = {
    paused,
    reason: opts.reason,
    at: new Date().toISOString(),
    by: opts.by,
  };
  data[companyId] = state;
  await writeFile(data);
  return state;
}

/** The one-line note returned to a caller whose request was throttled. */
export const PAUSED_MESSAGE =
  "Agents are paused (usage throttle). Resume in the Tethr UI (Providers page) or say “resume agents” in Slack.";
