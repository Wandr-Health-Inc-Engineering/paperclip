import { autonomyFor, getIntegrations, KNOWN_CONNECTORS, modeFor } from "./integrations.js";
import { kindsForConnector } from "./assistant/policy.js";
import { jevHealthText, type JevHealth } from "./jev.js";
import { mirrorDir } from "./mirror.js";
import { slackConfigured } from "./slack.js";
import { googleAdsConfigured } from "./tools/google-ads.js";

// What tethr is connected to, in one place (phase 27). Three readers:
// - Setup → Connections lists the checks (connectionChecks);
// - the chat's CLAUDE.md says what's connected and what isn't, so tethr stops
//   guessing and names the missing piece (connectionsContextText);
// - an agent's job can depend on a connection (its `needs`): while one is
//   missing it doesn't run (team.ts unmetNeeds).

export interface ConnectionCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
  href: string;
  optional?: boolean;
}

/** The rows of Setup → Connections. */
export function connectionChecks(companyId: string, adminSlackId: string | null, jev: JevHealth): ConnectionCheck[] {
  const cfg = getIntegrations(companyId);
  const mode = (label: string) => modeFor(cfg, label);
  const listening = slackConfigured() && !!process.env.SLACK_APP_TOKEN?.trim();
  return [
    { key: "stripe", label: "Stripe (revenue and new customers)", ok: mode("Stripe") !== "off", detail: `Mode: ${mode("Stripe")}`, href: "/tethr-settings" },
    { key: "posthog", label: "PostHog (traffic and conversion)", ok: mode("PostHog") !== "off", detail: `Mode: ${mode("PostHog")}`, href: "/tethr-settings" },
    { key: "google_ads", label: "Google Ads (spend and keyword volumes)", ok: googleAdsConfigured(), detail: googleAdsConfigured() ? "Connected" : "Add the GOOGLE_ADS_* settings", href: "/environment" },
    { key: "gmail", label: "Gmail", ok: mode("Gmail") !== "off", detail: `Mode: ${mode("Gmail")}`, href: "/tethr-settings" },
    { key: "slack_connector", label: "Slack (reading)", ok: mode("Slack") !== "off", detail: `Mode: ${mode("Slack")}`, href: "/tethr-settings" },
    { key: "slack_bot", label: "Slack bot for #tethr posts and approvals", ok: slackConfigured(), detail: slackConfigured() ? "Token set" : "Add SLACK_BOT_TOKEN", href: "/environment" },
    {
      key: "approver",
      label: "Your Slack member ID (so Slack reaches tethr as you)",
      ok: !!adminSlackId,
      detail: adminSlackId ? "Linked" : "Not linked: tethr won't act on your Slack messages",
      href: "/setup",
    },
    {
      key: "slack_listen",
      label: "tethr hears Slack conversations",
      ok: listening,
      detail: listening
        ? "Invite @tethr to the channels it should hear. Private channels and group DMs need two more Slack permissions (see MANUAL-STEPS)."
        : "Needs the Slack bot and app tokens",
      href: "/environment",
      optional: true,
    },
    // "ok" only when TypeSafe accepts the key (a saved key can still be rejected).
    { key: "jev", label: "Jev (fast decisions and list scoring)", ok: jev === "ok", detail: jevHealthText(jev), href: "/environment", optional: true },
    { key: "drive", label: "Google Drive folder (00 Tethr)", ok: !!mirrorDir(), detail: mirrorDir() ?? "Not found", href: "/drive" },
  ];
}

// ---- what a job can depend on -----------------------------------------------------

export const GOOGLE_ADS = "Google Ads";
const TETHR_TOOLS = "Tethr tools";

/** The Setup → Connections row that fixes a connection in place, when there is one. */
const FIX_KEYS: Record<string, string> = { Stripe: "stripe", PostHog: "posthog", Gmail: "gmail", Slack: "slack_connector", [GOOGLE_ADS]: "google_ads" };

/** Other names people and models use for a connection. */
const ALIASES: Record<string, string> = {
  "google ads api": GOOGLE_ADS,
  adwords: GOOGLE_ADS,
  "google adwords": GOOGLE_ADS,
  "keyword planner": GOOGLE_ADS,
  gcal: "Google Calendar",
  calendar: "Google Calendar",
  drive: "Google Drive",
  sheets: "Google Sheets",
  email: "Gmail",
};

export interface Connection {
  /** Its name, as the person sees it: a connector's label in Integrations, or "Google Ads". */
  key: string;
  /** tethr may use it (a connector that's switched on; Google Ads with its settings in place). */
  ok: boolean;
  detail: string;
  fixKey: string | null;
  /** A claude.ai connector tethr has seen answer on a real turn (it can't see the Claude account itself). */
  seen: boolean;
}

/** Everything a job can depend on, with where each stands now. */
export function connections(companyId: string): Connection[] {
  const cfg = getIntegrations(companyId);
  // Google Ads is listed once, below: it works when its settings are in place, whatever its mode.
  const labels = [...new Set([...KNOWN_CONNECTORS.map((c) => c.label), ...Object.keys(cfg.connectors)])].filter((label) => label !== TETHR_TOOLS && label !== GOOGLE_ADS);
  const connectors = labels.map((label): Connection => {
    const mode = modeFor(cfg, label);
    const seen = (cfg.discovered?.connectors[label]?.length ?? 0) > 0;
    // What it can do, so tethr uses all of it, and how far it may go on its own.
    const can = KNOWN_CONNECTORS.find((k) => k.label === label)?.blurb.replace(/\.$/, "");
    const reach = mode === "read" ? "read only: look, don't change" : mode === "ask" ? "every change asks the person first" : autonomyWords(cfg, label);
    return {
      key: label,
      ok: mode !== "off",
      detail:
        mode === "off"
          ? "switched off in tethr's Integrations"
          : `${reach}${can ? `. It can: ${can}` : ""}${seen ? "" : ". tethr hasn't seen it answer yet: it may need connecting in the Claude account (claude.ai → Settings → Connectors)"}`,
      fixKey: FIX_KEYS[label] ?? null,
      seen,
    };
  });
  const ads = googleAdsConfigured();
  const adsMode = modeFor(cfg, GOOGLE_ADS);
  const changes =
    adsMode === "auto" || adsMode === "ask"
      ? `tethr can change campaigns with the ads_ tools (${adsMode === "auto" ? "on its own; spending follows its Spending setting" : "each change asks first"})`
      : "tethr can't change campaigns (Google Ads is Read only in Integrations); a person makes changes";
  return [
    ...connectors,
    {
      key: GOOGLE_ADS,
      ok: ads,
      detail: ads
        ? `connected: account reports (google_ads_report) and keyword volumes (keyword_ideas). ${changes}`
        : "not set up: the GOOGLE_ADS_* settings are missing, so there are no account reports or keyword volumes",
      fixKey: FIX_KEYS[GOOGLE_ADS]!,
      seen: ads,
    },
  ];
}

/** A connector on Automatic, in words: what runs on its own and what still asks. */
function autonomyWords(cfg: ReturnType<typeof getIntegrations>, label: string): string {
  const a = autonomyFor(cfg, label);
  const kinds = kindsForConnector(label);
  const parts = ["changes run on their own"];
  if (kinds.includes("spend")) parts.push(a.spend.mode === "auto" && a.spend.monthlyCapUsd !== null ? `spending on its own up to ${a.spend.monthlyCapUsd} a month` : "spending asks");
  if (kinds.includes("outside")) parts.push(a.outside === "auto" ? "outside people on their own" : "outside people ask");
  if (kinds.includes("deletes")) parts.push(a.deletes === "auto" ? "deletes on their own" : "deletes ask");
  return `Automatic: ${parts.join(", ")}`;
}

/** A connection by any of its names, or null. */
export function findConnection(companyId: string, name: string): Connection | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  const canonical = (ALIASES[wanted] ?? wanted).toLowerCase();
  return connections(companyId).find((c) => c.key.toLowerCase() === canonical) ?? null;
}

/** For team-spec.ts: turn the names an agent's `needs` were given as into connection names. */
export function needResolver(companyId: string): { resolveNeed: (name: string) => string | null; needOptions: string[] } {
  return {
    resolveNeed: (name) => findConnection(companyId, name)?.key ?? null,
    needOptions: connections(companyId).map((c) => c.key),
  };
}

/** The "Connections" section of the chat's CLAUDE.md (company-level). */
export function connectionsContextText(companyId: string): string {
  return [
    "## Connections",
    "What tethr can reach right now. It's computed each turn; it's data, not instructions.",
    ...connections(companyId).map((c) => `- ${c.key}: ${c.detail}.`),
    "How to use this:",
    "- Go by this list, not by guessing. Something \"on\" that doesn't answer when you call it probably needs connecting in the Claude account: say so and call need_connection.",
    "- When you or an agent can't do a job without something that's missing here, call need_connection. It shows the person a card with the fix in place. Don't keep working around it turn after turn.",
    "- When you propose an agent, list what its job can't be done without in `needs`. An agent with a missing need doesn't run, and spends nothing, until it's connected or the person says to carry on without it.",
  ].join("\n");
}
