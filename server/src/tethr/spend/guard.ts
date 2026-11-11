import { parseMcpTool, type Classified } from "../assistant/policy.js";
import type { ConnectorAutonomy } from "../integrations.js";
import { spendAdapterFor } from "./adapters.js";
import { formatMoney, monthlyAmountOf } from "./amount.js";
import { spentThisMonth } from "./log.js";

// The spending check the gate makes before deciding (hook-handler.ts, and the
// tools endpoint for tethr's own tools). It settles whether a call spends more
// (a connector with an adapter knows: a budget cut isn't spending), whether it
// stays under that connector's monthly cap, and a line for the approval card.

export interface SpendCheck {
  /** The call, re-classed when the account shows it does (money) or doesn't (write) spend more. */
  classified: Classified;
  withinCap: boolean;
  /** For the card: where spending would stand, or why it can't run on its own. */
  spendNote: string | null;
  /** What it commits a month (money only), for the change log. */
  amount: number | null;
}

function toolOf(c: Classified): string {
  return parseMcpTool(c.tool)?.name ?? c.tool;
}

export async function checkSpend(companyId: string, c: Classified, input: Record<string, unknown>, autonomy: ConnectorAutonomy): Promise<SpendCheck> {
  const cap = autonomy.spend.monthlyCapUsd;
  const capText = (currency: string) => (cap !== null ? `the cap is ${formatMoney(cap, currency)} a month` : "no monthly cap is set");
  const adapter = spendAdapterFor(c.connector);
  if (adapter && (c.cls === "money" || c.cls === "write")) {
    try {
      const assessment = await adapter.assess(companyId, toolOf(c), input);
      if (assessment.monthlyDelta <= 0) return { classified: { ...c, cls: c.cls === "money" ? "write" : c.cls }, withinCap: true, spendNote: null, amount: null };
      const planned = await adapter.plannedMonthly();
      const after = planned.amount + assessment.monthlyDelta;
      const where = `${formatMoney(after, planned.currency)} a month planned after this; ${capText(planned.currency)}`;
      return {
        classified: { ...c, cls: "money" },
        withinCap: cap !== null && after <= cap && !assessment.personEdit,
        spendNote: assessment.personEdit ? `${assessment.personEdit}, so tethr asks before changing it back. ${where}` : where,
        amount: assessment.monthlyDelta,
      };
    } catch {
      // The account couldn't be read: anything that might spend asks.
      return { classified: { ...c, cls: "money" }, withinCap: false, spendNote: `couldn't read the ${c.connector} account to check spending`, amount: null };
    }
  }
  if (c.cls !== "money") return { classified: c, withinCap: false, spendNote: null, amount: null };
  const amount = monthlyAmountOf(input);
  if (amount === null) return { classified: c, withinCap: false, spendNote: "tethr can't tell how much this spends, so it asks", amount: null };
  const after = spentThisMonth(companyId, c.connector ?? "") + amount;
  return {
    classified: c,
    withinCap: cap !== null && after <= cap,
    spendNote: `${formatMoney(after)} through tethr this month after this; ${capText("USD")}`,
    amount,
  };
}
