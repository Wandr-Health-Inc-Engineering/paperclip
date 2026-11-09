import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolvePaperclipInstanceId } from "../../home-paths.js";
import { assistantHome } from "../assistant/workspace.js";
import { HELPER_SOURCE, RESULT_MARKER, type HelperOp } from "./helper.js";
import { MEMORY_LIMITS } from "./entries.js";

// The only code that talks to Hermes (phase 25). Hermes is tethr's memory layer:
// it stores tethr's notes, keeps every conversation searchable and holds the
// skills tethr learns. Claude Code on the subscription does all the thinking;
// Hermes never runs a turn for tethr, so it never calls a model:
// - tethr's profile has no provider and borrows no logins (PROFILE_CONFIG);
// - the helper runs with a minimal environment (no API keys to find);
// - only the data operations in HELPER_OPS exist (helper.ts).

export interface HermesInstall {
  /** The `hermes` launcher. */
  bin: string;
  /** Hermes's own Python, and its source checkout. */
  python: string;
  agentDir: string;
}

const FIND_TTL_MS = 5 * 60_000;
const MISS_TTL_MS = 60_000;
let found: { at: number; install: HermesInstall | null } | null = null;

/** Hermes's data root (~/.hermes unless HERMES_HOME or TETHR_HERMES_ROOT says otherwise). */
export function hermesRoot(): string {
  if (process.env.TETHR_HERMES_ROOT) return process.env.TETHR_HERMES_ROOT;
  const home = process.env.HERMES_HOME?.trim();
  if (home) return path.basename(path.dirname(home)) === "profiles" ? path.dirname(path.dirname(home)) : home;
  return path.join(os.homedir(), ".hermes");
}

export function profileHome(profile: string): string {
  return path.join(hermesRoot(), "profiles", profile);
}

const slug = (v: string | null | undefined, max: number) => String(v ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, max);

/** A Hermes profile name for a company (Hermes: lowercase letters, digits, - and _).
 * Every tethr instance on this computer shares one Hermes, and every fresh
 * instance starts with the same company prefix, so any instance but the default
 * one carries its own id: a test copy can never open the real one's memory. */
export function profileNameFor(issuePrefix: string | null | undefined, instanceId: string = resolvePaperclipInstanceId()): string {
  const instance = slug(instanceId, 20);
  const parts = ["tethr", instance && instance !== "default" ? instance : "", slug(issuePrefix, 30)].filter(Boolean);
  return parts.join("-");
}

function candidateBins(): string[] {
  const fromPath = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, "hermes"));
  return [
    process.env.TETHR_HERMES_BIN ?? "",
    ...fromPath,
    path.join(os.homedir(), ".local", "bin", "hermes"),
    path.join(os.homedir(), ".hermes", "hermes-agent", ".hermes", "bin", "hermes"),
  ].filter(Boolean);
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The environment Hermes runs with: nothing it could use to reach a model. */
export function hermesEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const keep = ["HOME", "PATH", "LANG", "LC_ALL", "TMPDIR", "USER", "LOGNAME"];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  return { ...env, ...extra };
}

/** Find Hermes through its own launcher (`--print-runtime-command` is its stable boundary). */
export async function findHermes(): Promise<HermesInstall | null> {
  if (process.env.TETHR_HERMES === "off") return null;
  // Tests use Hermes only when they point tethr at a throwaway Hermes root.
  if (process.env.VITEST && !process.env.TETHR_HERMES_ROOT) return null;
  if (found && Date.now() - found.at < (found.install ? FIND_TTL_MS : MISS_TTL_MS)) return found.install;
  let install: HermesInstall | null = null;
  for (const bin of candidateBins()) {
    if (!isExecutable(bin)) continue;
    install = await new Promise<HermesInstall | null>((resolve) => {
      execFile(bin, ["--print-runtime-command", "--module", "json.tool"], { timeout: 20_000, env: hermesEnv({}) }, (err, stdout) => {
        if (err) return resolve(null);
        try {
          const cmd = JSON.parse(String(stdout).trim().split("\n").pop() ?? "") as string[];
          const python = cmd[0] ?? "";
          const agentDir = (cmd.find((c) => c.includes("sys.path.insert")) ?? "").match(/sys\.path\.insert\(0, '([^']+)'\)/)?.[1] ?? "";
          resolve(python && agentDir && isExecutable(python) && fs.existsSync(agentDir) ? { bin, python, agentDir } : null);
        } catch {
          resolve(null);
        }
      });
    });
    if (install) break;
  }
  found = { at: Date.now(), install };
  return install;
}

/** Tests: forget what was found. */
export function resetHermesCache(): void {
  found = null;
}

/** tethr's profile config: storage and search only. Nothing here may call a model. */
export const PROFILE_CONFIG = `# tethr's memory profile (written by tethr). tethr only stores and searches
# here; it never runs a Hermes agent in this profile. Nothing may call a model:
# no provider, no borrowed logins, no background review, no consolidation.
model:
  default: ""
  provider: "none"
auth:
  adopt_external_logins: false
memory:
  memory_enabled: true
  user_profile_enabled: true
  memory_char_limit: ${MEMORY_LIMITS.company}
  user_char_limit: ${MEMORY_LIMITS.people}
  nudge_interval: 0
skills:
  creation_nudge_interval: 0
auxiliary:
  background_review:
    enabled: false
curator:
  consolidate: false
telemetry:
  shared_metrics:
    enabled: false
    send: false
`;

/** The settings that keep the profile model-free, checked by status(). */
const LOCKDOWN_CHECKS: Array<[string, RegExp]> = [
  ["no model provider", /^\s*provider:\s*"?none"?\s*$/m],
  ["no borrowed logins", /^\s*adopt_external_logins:\s*false\s*$/m],
  ["no background review", /background_review:\s*\n\s*enabled:\s*false/m],
  ["no consolidation", /^\s*consolidate:\s*false\s*$/m],
];

/** Which lockdown settings are missing from a profile's config (empty = locked down). */
export function lockdownGaps(config: string): string[] {
  return LOCKDOWN_CHECKS.filter(([, re]) => !re.test(config)).map(([label]) => label);
}

/** Create tethr's profile (folder + locked-down config) if it isn't there. A
 * config a person has edited is left alone; status() reports any gap. */
export async function ensureProfile(profile: string): Promise<{ home: string; created: boolean }> {
  const home = profileHome(profile);
  const config = path.join(home, "config.yaml");
  if (fs.existsSync(config)) return { home, created: false };
  await fsp.mkdir(path.join(home, "memories"), { recursive: true, mode: 0o700 });
  await fsp.writeFile(config, PROFILE_CONFIG, { encoding: "utf8", mode: 0o600, flag: "wx" }).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "EEXIST") throw err;
  });
  return { home, created: true };
}

/** `base`, or `base-2`, `base-3`… when a profile folder with that name is already
 * there. A company switching Hermes on for the first time never adopts a profile
 * it didn't make (one left by a company wiped in a fresh start keeps its memory
 * on disk, untouched, and the new company starts clean). */
export function freeProfileName(base: string): string {
  if (!fs.existsSync(profileHome(base))) return base;
  for (let n = 2; n < 100; n++) if (!fs.existsSync(profileHome(`${base}-${n}`))) return `${base}-${n}`;
  throw new HermesError(`Too many Hermes profiles named ${base}.`);
}

export function profileExists(profile: string): boolean {
  return fs.existsSync(path.join(profileHome(profile), "config.yaml"));
}

export function readProfileConfig(profile: string): string {
  try {
    return fs.readFileSync(path.join(profileHome(profile), "config.yaml"), "utf8");
  } catch {
    return "";
  }
}

async function ensureHelperScript(): Promise<string> {
  const hash = crypto.createHash("sha256").update(HELPER_SOURCE).digest("hex").slice(0, 12);
  const dir = path.join(assistantHome(), "hermes");
  const file = path.join(dir, `tethr-hermes-${hash}.py`);
  await fsp.mkdir(dir, { recursive: true });
  try {
    await fsp.access(file);
  } catch {
    await fsp.writeFile(file, HELPER_SOURCE, "utf8");
  }
  return file;
}

export class HermesError extends Error {}

const TIMEOUTS: Partial<Record<HelperOp, number>> = { "sessions.import": 180_000 };

/** Run one helper operation in tethr's profile. Throws HermesError when Hermes
 * isn't there or the operation failed outright. */
export async function runHelper<T = unknown>(profile: string, op: HelperOp, args: Record<string, unknown> = {}): Promise<T> {
  const install = await findHermes();
  if (!install) throw new HermesError("Hermes isn't installed on this computer.");
  if (!profileExists(profile)) throw new HermesError(`tethr's Hermes profile (${profile}) isn't set up.`);
  const script = await ensureHelperScript();
  const timeout = TIMEOUTS[op] ?? 30_000;
  return new Promise<T>((resolve, reject) => {
    const child = spawn(install.python, ["-I", script], {
      env: hermesEnv({ HERMES_HOME: profileHome(profile), HERMES_AGENT_DIR: install.agentDir }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new HermesError(`Hermes took too long (${op}).`));
    }, timeout);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => {
      if (stderr.length < 4000) stderr += c;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new HermesError(`Couldn't start Hermes: ${err.message}`));
    });
    child.on("close", () => {
      clearTimeout(timer);
      const line = stdout.split("\n").find((l) => l.startsWith(RESULT_MARKER));
      if (!line) return reject(new HermesError(`Hermes gave no answer (${op})${stderr ? `: ${stderr.trim().split("\n").pop()}` : ""}.`));
      try {
        const reply = JSON.parse(line.slice(RESULT_MARKER.length)) as { ok: boolean; result?: T; error?: string };
        if (!reply.ok) return reject(new HermesError(reply.error ?? `Hermes couldn't do ${op}.`));
        resolve(reply.result as T);
      } catch {
        reject(new HermesError(`Hermes gave an answer tethr couldn't read (${op}).`));
      }
    });
    child.stdin.end(JSON.stringify({ op, args }));
  });
}
