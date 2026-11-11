import type { TethrConnectorActivity, TethrConnectorAutonomy } from "@/api/tethr";

// Pure wording for a connector's autonomy panel (settings/ConnectorAutonomy.tsx).

const money = (n: number, currency = "USD") => {
  const text = Math.round(n).toLocaleString("en-US");
  return currency === "USD" ? `$${text}` : `${text} ${currency}`;
};

/** One line for the closed panel: "Changes run on their own · spending asks · deletes ask". */
export function autonomySummary(kinds: Array<"spend" | "outside" | "deletes">, a: TethrConnectorAutonomy): string {
  const parts: string[] = ["Changes run on their own"];
  if (kinds.includes("spend")) {
    parts.push(a.spend.mode === "auto" && a.spend.monthlyCapUsd !== null ? `spending on its own up to ${money(a.spend.monthlyCapUsd)}/mo` : "spending asks");
  }
  if (kinds.includes("outside")) parts.push(a.outside === "auto" ? "outside people on their own" : "outside people ask");
  if (kinds.includes("deletes")) parts.push(a.deletes === "auto" ? "deletes on their own" : "deletes ask");
  return parts.join(" · ");
}

/** Why a typed cap can't be saved, or null. */
export function capProblem(cap: number | null): string | null {
  if (cap === null) return null;
  if (!Number.isFinite(cap) || cap < 1) return "The cap is an amount of at least $1 a month.";
  if (cap > 1_000_000) return "That's above the most tethr can be set to.";
  return null;
}

/** Where spending stands against the cap, in a line. */
export function spendLine(activity: TethrConnectorActivity): string {
  const cap = activity.cap === null ? "no cap set" : `cap ${money(activity.cap, activity.planned?.currency)}`;
  if (activity.planned) return `Planned now: ${money(activity.planned.amount, activity.planned.currency)} a month · ${cap}`;
  if (activity.plannedError) return `Couldn't read the account (${activity.plannedError}) · ${cap}`;
  return `Spent through tethr this month: ${money(activity.spentThisMonth)} · ${cap}`;
}
