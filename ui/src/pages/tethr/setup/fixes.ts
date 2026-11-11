import type { StepKey } from "./shared";

// How each Connections row is fixed without leaving setup: a key to paste
// (saved to the instance settings file), a connector mode to pick, a step to
// go back to, or plain instructions. Keyed by the server's check key.

export interface EnvField {
  /** The setting's name in the instance .env. */
  key: string;
  label: string;
  /** What the value looks like, shown as the field's placeholder. */
  placeholder: string;
  secret: boolean;
  optional?: boolean;
}

export type CheckFix =
  | { kind: "env"; how: string; fields: EnvField[]; restart?: boolean }
  | { kind: "connector"; connector: string; how: string }
  | { kind: "step"; step: StepKey; how: string }
  | { kind: "slack-id"; how: string }
  | { kind: "info"; how: string };

const CONNECTOR_HOW =
  "Connect it in your Claude account first: claude.ai, Settings, Connectors. Then pick what tethr may do with it here. tethr can't see your Claude account from this page; the goals interview tells you if it doesn't answer.";

const SLACK_BOT_TOKEN: EnvField = { key: "SLACK_BOT_TOKEN", label: "Bot token", placeholder: "xoxb-…", secret: true };
const SLACK_APP_TOKEN: EnvField = { key: "SLACK_APP_TOKEN", label: "App-level token", placeholder: "xapp-…", secret: true };

export const CHECK_FIX: Record<string, CheckFix> = {
  stripe: { kind: "connector", connector: "Stripe", how: CONNECTOR_HOW },
  posthog: { kind: "connector", connector: "PostHog", how: CONNECTOR_HOW },
  gmail: { kind: "connector", connector: "Gmail", how: CONNECTOR_HOW },
  slack_connector: { kind: "connector", connector: "Slack", how: CONNECTOR_HOW },
  google_ads: {
    kind: "env",
    how: "From your Google Ads API setup (GOOGLE-SETUP.md in the repo walks through it). The developer token needs Basic or Standard access for keyword volumes.",
    fields: [
      { key: "GOOGLE_ADS_DEVELOPER_TOKEN", label: "Developer token", placeholder: "22 characters", secret: true },
      { key: "GOOGLE_ADS_CLIENT_ID", label: "OAuth client ID", placeholder: "….apps.googleusercontent.com", secret: false },
      { key: "GOOGLE_ADS_CLIENT_SECRET", label: "OAuth client secret", placeholder: "GOCSPX-…", secret: true },
      { key: "GOOGLE_ADS_REFRESH_TOKEN", label: "Refresh token", placeholder: "1//…", secret: true },
      { key: "GOOGLE_ADS_CUSTOMER_ID", label: "Customer ID", placeholder: "1234567890, no dashes", secret: false },
      { key: "GOOGLE_ADS_LOGIN_CUSTOMER_ID", label: "Manager account ID", placeholder: "only if you use a manager account", secret: false, optional: true },
    ],
  },
  slack_bot: {
    kind: "env",
    how: "In your Slack app (api.slack.com/apps): OAuth & Permissions, Bot User OAuth Token. Restart tethr from the launcher after saving.",
    fields: [SLACK_BOT_TOKEN],
    restart: true,
  },
  slack_listen: {
    kind: "env",
    how: "Both tokens from your Slack app: the bot token (OAuth & Permissions) and an app-level token with connections:write (Basic Information, App-Level Tokens). Restart tethr from the launcher after saving, then invite @tethr to the channels it should hear.",
    fields: [SLACK_BOT_TOKEN, SLACK_APP_TOKEN],
    restart: true,
  },
  jev: {
    kind: "env",
    how: "Optional. Jev (from TypeSafe AI) makes fast, cheap decisions and scores long lists. Without it, tethr does that itself, just slower. Paste either a Vercel AI Gateway key (starts with vck_; billed through Vercel) or a TypeSafe key from console.typesafe.ai. tethr tells them apart on its own. If you have neither, leave this and continue.",
    fields: [{ key: "TYPESAFE_API_KEY", label: "Jev key (Vercel AI Gateway or TypeSafe)", placeholder: "vck_… or your TypeSafe key", secret: true }],
  },
  approver: {
    kind: "slack-id",
    how: "With your Slack member ID, a message to tethr in Slack reaches the same tethr as this app, and you can approve from Slack. Without it, tethr won't act on Slack messages. In Slack: your profile, then ⋯, then Copy member ID.",
  },
  drive: {
    kind: "env",
    how: "The 00 Tethr folder inside Google Drive for Desktop, where tethr files its work. Make sure Drive for Desktop is running and signed in, then paste the folder's full path (in Finder: right-click the folder, hold Option, Copy as Pathname).",
    fields: [{ key: "TETHR_MIRROR_DIR", label: "Folder path", placeholder: "/Users/you/Library/CloudStorage/GoogleDrive-…/My Drive/00 Tethr", secret: false }],
  },
};

/** The Connections row that fixes each thing an agent can be waiting for. */
const FIX_FOR_CONNECTION: Record<string, string> = { Stripe: "stripe", PostHog: "posthog", Gmail: "gmail", Slack: "slack_connector", "Google Ads": "google_ads" };

/** How a missing connection is fixed in place (a connection card in the chat or on Needs you). */
export function fixForConnection(key: string): CheckFix {
  return CHECK_FIX[FIX_FOR_CONNECTION[key] ?? ""] ?? { kind: "connector", connector: key, how: CONNECTOR_HOW };
}
