import { googleAdsAdapter } from "../tools/google-ads-write.js";

// Connectors tethr can read an account for, so their spending cap is checked
// against what the account itself plans to spend (Google Ads today). A
// connector without one is held to what tethr's own calls committed this month
// (spend/log.ts). Adding Meta or another platform natively = registering one
// adapter here.

export interface SpendAssessment {
  /** What the call adds to planned monthly spend (0 or less: it doesn't spend more). */
  monthlyDelta: number;
  /** A person's recent edit this call would undo ("you paused it in Google Ads on Nov 8"), or null. */
  personEdit: string | null;
}

export interface SpendAdapter {
  connector: string;
  configured(): boolean;
  /** What the account plans to spend in a month now, and in what currency. */
  plannedMonthly(): Promise<{ amount: number; currency: string }>;
  /** What one call (a tool name on this connector, and its input) would change. */
  assess(companyId: string, tool: string, input: Record<string, unknown>): Promise<SpendAssessment>;
}

const registry = new Map<string, SpendAdapter>([[googleAdsAdapter.connector, googleAdsAdapter]]);

export function registerSpendAdapter(adapter: SpendAdapter): void {
  registry.set(adapter.connector, adapter);
}

/** For tests: put a fake in place (null removes it). */
export function setSpendAdapterForTests(connector: string, adapter: SpendAdapter | null): void {
  if (adapter) registry.set(connector, adapter);
  else if (connector === googleAdsAdapter.connector) registry.set(connector, googleAdsAdapter);
  else registry.delete(connector);
}

export function spendAdapterFor(connector: string | null): SpendAdapter | null {
  if (!connector) return null;
  const adapter = registry.get(connector);
  return adapter && adapter.configured() ? adapter : null;
}
