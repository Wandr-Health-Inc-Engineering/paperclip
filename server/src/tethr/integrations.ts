import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import type { ConnectorMode } from "./assistant/policy.js";

// Integrations config for the chat assistant (phase 18): per-connector modes
// (off / read / ask = approval required / auto), the email domains that count
// as "inside Wandr", the shell mode, and which chat engine runs. Human-owned
// local config in the instance dir, same pattern as throttle / overseers /
// drive mounts — no agent can change it. The Integrations page edits it.

export type ChatEngine = "session" | "routing";

export interface ConnectorSetting {
  mode: ConnectorMode;
  /** Plain-language scope for reads, written into the workspace CLAUDE.md (e.g. Gmail labels). */
  scope?: string;
}

export interface IntegrationsConfig {
  defaultMode: ConnectorMode;
  connectors: Record<string, ConnectorSetting>;
  internalAddresses: string[];
  shell: "off" | "ask";
  assistant: { engine: ChatEngine; model: string };
  /** Tool names seen per connector (filled from real turns). */
  discovered?: { at: string; connectors: Record<string, string[]> };
}

export const DEFAULT_INTEGRATIONS: IntegrationsConfig = {
  // Approval required for anything outward, unless a connector is set otherwise.
  defaultMode: "ask",
  connectors: {
    Mercury: { mode: "off" },
    Canva: { mode: "off" },
    Figma: { mode: "off" },
  },
  internalAddresses: ["travelwithwandr.com"],
  shell: "off",
  assistant: { engine: "session", model: "sonnet" },
};

interface FileShape {
  [companyId: string]: Partial<IntegrationsConfig>;
}

function configPath(): string {
  if (process.env.TETHR_INTEGRATIONS_FILE) return process.env.TETHR_INTEGRATIONS_FILE;
  return path.resolve(resolvePaperclipInstanceRoot(), "tethr-integrations.json");
}

function readFile(): FileShape {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as FileShape) : {};
  } catch {
    return {};
  }
}

export function getIntegrations(companyId: string): IntegrationsConfig {
  const saved = readFile()[companyId] ?? {};
  return {
    ...DEFAULT_INTEGRATIONS,
    ...saved,
    connectors: { ...DEFAULT_INTEGRATIONS.connectors, ...(saved.connectors ?? {}) },
    assistant: { ...DEFAULT_INTEGRATIONS.assistant, ...(saved.assistant ?? {}) },
    internalAddresses: saved.internalAddresses ?? DEFAULT_INTEGRATIONS.internalAddresses,
  };
}

export async function updateIntegrations(
  companyId: string,
  patch: Partial<IntegrationsConfig>,
): Promise<IntegrationsConfig> {
  const data = readFile();
  const current = data[companyId] ?? {};
  data[companyId] = {
    ...current,
    ...patch,
    connectors: { ...(current.connectors ?? {}), ...(patch.connectors ?? {}) },
    assistant: { ...(current.assistant ?? DEFAULT_INTEGRATIONS.assistant), ...(patch.assistant ?? {}) },
  };
  const file = configPath();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fsp.rename(tmp, file);
  return getIntegrations(companyId);
}

/** The effective mode for a connector. Mercury (money) is capped at "ask". */
export function modeFor(cfg: IntegrationsConfig, connector: string | null): ConnectorMode {
  if (!connector) return cfg.defaultMode;
  const mode = cfg.connectors[connector]?.mode ?? cfg.defaultMode;
  return connector === "Mercury" && mode === "auto" ? "ask" : mode;
}

/** Deny rules for --settings: every Off connector, plus the stray user-scope PostHog server. */
export function denyRulesFor(cfg: IntegrationsConfig): string[] {
  const rules = ["mcp__posthog"];
  for (const [label, setting] of Object.entries(cfg.connectors)) {
    if (setting.mode === "off") rules.push(`mcp__claude_ai_${label.replace(/ /g, "_")}`);
  }
  // A default of "off" for unlisted connectors is enforced by the gate (decide()).
  return rules;
}

/** The "Integration rules" text written into the workspace CLAUDE.md each turn. */
export function integrationRulesText(cfg: IntegrationsConfig): string {
  const lines = [
    "- Read Mark's connected tools to find real answers instead of guessing. Load a connector with ToolSearch when you need it.",
    "- Outward actions (sending email, posting to Slack, changing calendars, Stripe, sharing files) go through Tethr's approval gate.",
    "- Gmail and Slack can contain customer messages. Skip anything that looks like a patient's health information; never quote it.",
  ];
  const off = Object.entries(cfg.connectors).filter(([, s]) => s.mode === "off").map(([l]) => l);
  if (off.length) lines.push(`- Turned off: ${off.join(", ")}. Don't try to use them.`);
  for (const [label, s] of Object.entries(cfg.connectors)) {
    if (s.scope && s.scope.trim()) lines.push(`- ${label}: ${s.scope.trim()}`);
  }
  if (cfg.internalAddresses.length) lines.push(`- Inside Wandr: ${cfg.internalAddresses.join(", ")}. Anyone else counts as outside.`);
  return lines.join("\n");
}

/** Remember tool names seen on real turns (cheap discovery for the Integrations page). */
export async function recordDiscoveredTools(companyId: string, toolNames: string[]): Promise<void> {
  if (!toolNames.length) return;
  const cfg = getIntegrations(companyId);
  const connectors: Record<string, string[]> = { ...(cfg.discovered?.connectors ?? {}) };
  let changed = false;
  for (const t of toolNames) {
    if (!t.startsWith("mcp__claude_ai_")) continue;
    const rest = t.slice("mcp__claude_ai_".length);
    const sep = rest.indexOf("__");
    if (sep <= 0) continue;
    const label = rest.slice(0, sep).replace(/_/g, " ");
    const name = rest.slice(sep + 2);
    const list = connectors[label] ?? [];
    if (!list.includes(name)) {
      connectors[label] = [...list, name].sort();
      changed = true;
    }
  }
  if (changed) await updateIntegrations(companyId, { discovered: { at: new Date().toISOString(), connectors } });
}
