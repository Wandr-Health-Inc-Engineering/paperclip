// Connectors whose tools tethr runs itself, on its own MCP server "tethr", but
// which count as their own connector in Integrations (their own mode and
// autonomy) rather than as "Tethr tools". Kept dependency-free: the policy and
// the settings both read it.

/** Google Ads' tools that change the account. Reports (google_ads_report) stay with Tethr tools. */
export const GOOGLE_ADS_WRITE_TOOLS = ["ads_create_campaign", "ads_change", "ads_set_budget"] as const;

/** A tethr-server tool's own connector label, or null when it's one of Tethr tools. */
export function nativeConnectorOf(toolName: string): string | null {
  return (GOOGLE_ADS_WRITE_TOOLS as readonly string[]).includes(toolName) ? "Google Ads" : null;
}
