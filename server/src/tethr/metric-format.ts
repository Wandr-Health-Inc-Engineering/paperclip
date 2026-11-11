// How a goal metric's numbers are rounded and written, in one place (the
// chat's goals text, Slack heads-ups and target-adjustment notes all use it).

/** Rounded the way people count the unit: whole customers, tidy dollars, one-decimal percentages. */
export function roundForUnit(value: number, unit: string): number {
  if (unit === "count") return Math.round(value);
  if (unit === "usd") return Math.abs(value) >= 1000 ? Math.round(value / 10) * 10 : Math.round(value);
  if (unit === "percent") return Math.round(value * 10) / 10;
  return Math.round(value * 100) / 100;
}

/** "$12,340", "4.5%", "140", or "?" when there's no number yet. */
export function formatMetricValue(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined) return "?";
  const rounded = roundForUnit(value, unit);
  if (unit === "usd") return `$${rounded.toLocaleString("en-US")}`;
  if (unit === "percent") return `${rounded}%`;
  return rounded.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
