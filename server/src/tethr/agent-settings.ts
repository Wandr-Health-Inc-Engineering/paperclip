import { kindsForConnector, type ConnectorMode } from "./assistant/policy.js";
import { autonomyFor, DEFAULT_CONNECTOR_AUTONOMY, modeFor, MONTHLY_CAP_LIMIT_USD, type ConnectorAutonomy, type IntegrationsConfig, type KindMode } from "./integrations.js";

// Each agent's own settings (Mark, 2026-11-10: "nesting settings for the agent
// within the agent panes themselves is better… if there's a paid ad agent
// that's the head that's where all the settings should live"). Per tool the
// agent has: Read only, Approval needed or Automatic, and under Automatic the
// same three kinds as Integrations (spending with its cap, outside people,
// deletes). A sub-agent uses its lead's. Integrations still decides what's
// connected (Off is off for everyone) and tethr's own settings; an agent with
// no entry for a tool follows tethr's, as before.

export type AgentToolMode = "read" | "ask" | "auto";
export interface AgentToolSetting {
  mode: AgentToolMode;
  autonomy: ConnectorAutonomy;
}
export type AgentSettings = Record<string, AgentToolSetting>;

/** tethr's own internal tools: always there, nothing to set. */
export const SETTINGLESS_TOOLS = new Set(["Tethr tools"]);
const MODES = new Set<AgentToolMode>(["read", "ask", "auto"]);
const RANK: Record<string, number> = { off: 0, read: 1, ask: 2, auto: 3 };

export class AgentSettingsError extends Error {}

const cloneAutonomy = (a: ConnectorAutonomy = DEFAULT_CONNECTOR_AUTONOMY): ConnectorAutonomy => ({ spend: { ...a.spend }, outside: a.outside, deletes: a.deletes });

/** A new tool's setting: Approval needed, every sensitive kind asking. */
export function defaultToolSetting(): AgentToolSetting {
  return { mode: "ask", autonomy: cloneAutonomy() };
}

/** Whose settings apply: a sub-agent's lead, else the agent itself. */
export function settingsOwner<T extends { leadTag: string | null }>(agent: T, lead: T | null | undefined): T {
  return agent.leadTag && lead ? lead : agent;
}

/** What an agent may do with one connector: its own setting, under what's connected. */
export function effectiveSettings(
  cfg: IntegrationsConfig,
  owner: { settings?: AgentSettings } | null | undefined,
  connector: string | null,
): { mode: ConnectorMode; autonomy: ConnectorAutonomy; source: "agent" | "tethr" } {
  const company = modeFor(cfg, connector);
  const tethrs = { mode: company, autonomy: autonomyFor(cfg, connector), source: "tethr" as const };
  if (!connector || company === "off") return tethrs;
  const own = owner?.settings?.[connector];
  if (!own) return tethrs;
  return { mode: own.mode, autonomy: cloneAutonomy(own.autonomy), source: "agent" };
}

function kind(v: unknown, byPerson: boolean): KindMode {
  return byPerson && v === "auto" ? "auto" : "ask";
}

function parseAutonomy(raw: unknown, byPerson: boolean, before?: ConnectorAutonomy): ConnectorAutonomy {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const base = before ?? DEFAULT_CONNECTOR_AUTONOMY;
  const spendRaw = (r.spend && typeof r.spend === "object" ? r.spend : {}) as Record<string, unknown>;
  const capGiven = "monthlyCapUsd" in spendRaw;
  const capRaw = spendRaw.monthlyCapUsd;
  const capNumber = capRaw === null || capRaw === "" || capRaw === undefined ? null : Number(capRaw);
  const cap = !capGiven ? base.spend.monthlyCapUsd : capNumber !== null && Number.isFinite(capNumber) && capNumber >= 1 && capNumber <= MONTHLY_CAP_LIMIT_USD ? Math.round(capNumber) : null;
  // Spending runs on its own only with a cap, and only when a person said so.
  const spendMode = "mode" in spendRaw ? kind(spendRaw.mode, byPerson) : byPerson ? base.spend.mode : "ask";
  return {
    spend: { mode: spendMode === "auto" && cap !== null ? "auto" : "ask", monthlyCapUsd: cap },
    outside: "outside" in r ? kind(r.outside, byPerson) : byPerson ? base.outside : "ask",
    deletes: "deletes" in r ? kind(r.deletes, byPerson) : byPerson ? base.deletes : "ask",
  };
}

/**
 * Settings for some of an agent's tools, checked. `byPerson`: only a person can
 * put spending, outside people or deletes on Automatic; from tethr they ask.
 * A tool given as a bare mode ("auto") is that mode with every kind asking.
 */
export function parseAgentSettings(raw: unknown, tools: string[], opts: { byPerson: boolean; before?: AgentSettings }): AgentSettings {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new AgentSettingsError("settings must map each tool to its mode, e.g. { \"Google Ads\": \"auto\" }.");
  const out: AgentSettings = {};
  for (const [label, value] of Object.entries(raw as Record<string, unknown>)) {
    if (SETTINGLESS_TOOLS.has(label)) continue;
    if (!tools.includes(label)) throw new AgentSettingsError(`settings: ${label} isn't one of its tools (${tools.join(", ") || "none"}).`);
    const v = typeof value === "string" ? { mode: value } : value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const before = opts.before?.[label];
    const mode = v.mode === undefined ? (before?.mode ?? "ask") : String(v.mode);
    if (!MODES.has(mode as AgentToolMode)) throw new AgentSettingsError(`settings: ${label}'s mode is read, ask (approval needed) or auto.`);
    out[label] = { mode: mode as AgentToolMode, autonomy: parseAutonomy(v.autonomy, opts.byPerson, before?.autonomy) };
  }
  return out;
}

/** What an agent that has been following tethr's settings has in effect now, per tool: where its own settings start. */
export function inheritedSettings(cfg: IntegrationsConfig, tools: string[]): AgentSettings {
  const out: AgentSettings = {};
  for (const tool of tools) {
    if (SETTINGLESS_TOOLS.has(tool)) continue;
    const mode = modeFor(cfg, tool);
    out[tool] = { mode: mode === "off" ? "read" : mode, autonomy: cloneAutonomy(autonomyFor(cfg, tool)) };
  }
  return out;
}

/** An entry for each settable tool: what's given, else Approval needed. Tools it no longer has are dropped. */
export function settingsForTools(tools: string[], given: AgentSettings = {}, before: AgentSettings = {}): AgentSettings {
  const out: AgentSettings = {};
  for (const tool of tools) {
    if (SETTINGLESS_TOOLS.has(tool)) continue;
    out[tool] = given[tool] ?? before[tool] ?? defaultToolSetting();
  }
  return out;
}

/** Does `after` let the agent do more on its own than `before` (a missing entry counts as Approval needed)? */
export function widensSettings(before: AgentSettings | undefined, after: AgentSettings): boolean {
  for (const [tool, next] of Object.entries(after)) {
    const prev = before?.[tool] ?? defaultToolSetting();
    if (RANK[next.mode]! > RANK[prev.mode]!) return true;
    const a = next.autonomy;
    const b = prev.autonomy;
    if ((a.outside === "auto" && b.outside !== "auto") || (a.deletes === "auto" && b.deletes !== "auto")) return true;
    if (a.spend.mode === "auto" && (b.spend.mode !== "auto" || (a.spend.monthlyCapUsd ?? 0) > (b.spend.monthlyCapUsd ?? 0))) return true;
  }
  return false;
}

/** Does it touch spending (for the card's money gate)? */
export function widensSpending(before: AgentSettings | undefined, after: AgentSettings): boolean {
  return Object.entries(after).some(([tool, next]) => {
    const prev = before?.[tool]?.autonomy.spend ?? DEFAULT_CONNECTOR_AUTONOMY.spend;
    return next.autonomy.spend.mode === "auto" && (prev.mode !== "auto" || (next.autonomy.spend.monthlyCapUsd ?? 0) > (prev.monthlyCapUsd ?? 0));
  });
}

const money = (n: number) => `$${n.toLocaleString("en-US")}`;

/** In words, for the sheet and the cards: what runs on its own, what needs approval, what it only looks at. */
export function settingsSummary(settings: AgentSettings | undefined, tools: string[]): { onItsOwn: string[]; needsApproval: string[]; lookOnly: string[] } {
  const onItsOwn: string[] = [];
  const needsApproval: string[] = [];
  const lookOnly: string[] = [];
  for (const tool of tools) {
    if (SETTINGLESS_TOOLS.has(tool)) continue;
    const s = settings?.[tool];
    if (!s) {
      needsApproval.push(`${tool}: follows tethr's settings`);
      continue;
    }
    if (s.mode === "read") {
      lookOnly.push(tool);
      continue;
    }
    if (s.mode === "ask") {
      needsApproval.push(`Every change in ${tool}`);
      continue;
    }
    onItsOwn.push(`Changes in ${tool}`);
    const kinds = kindsForConnector(tool);
    const a = s.autonomy;
    if (kinds.includes("spend")) {
      if (a.spend.mode === "auto" && a.spend.monthlyCapUsd !== null) {
        onItsOwn.push(`Spending in ${tool} up to ${money(a.spend.monthlyCapUsd)} a month`);
        needsApproval.push(`Spending in ${tool} past ${money(a.spend.monthlyCapUsd)} a month`);
      } else {
        needsApproval.push(`Spending in ${tool}`);
      }
    }
    if (kinds.includes("outside")) (a.outside === "auto" ? onItsOwn : needsApproval).push(`Reaching people outside the company through ${tool}`);
    if (kinds.includes("deletes")) (a.deletes === "auto" ? onItsOwn : needsApproval).push(`Deleting in ${tool}`);
  }
  needsApproval.push("Anything medical");
  return { onItsOwn, needsApproval, lookOnly };
}

/** The same, as card lines. */
export function settingsLines(settings: AgentSettings | undefined, tools: string[]): string[] {
  const s = settingsSummary(settings, tools);
  return [
    `Runs on its own: ${s.onItsOwn.length ? s.onItsOwn.join("; ") : "nothing yet"}`,
    `Needs your approval: ${s.needsApproval.join("; ")}`,
    ...(s.lookOnly.length ? [`Looks only: ${s.lookOnly.join(", ")}`] : []),
  ];
}
