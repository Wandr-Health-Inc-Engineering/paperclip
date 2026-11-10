// How much a connector call spends, read from its input (spend/guard.ts uses it
// for connectors tethr can't read an account for). Generic on purpose: a field
// that ends in _micros is millionths, one that ends in _cents is cents, and the
// usual names (amount, budget, bid, price) are in the account's currency. A
// daily budget counts for a month (× 30.4). When there's no amount to read,
// the answer is null and the call asks.

export const DAYS_PER_MONTH = 30.4;

const MICROS = /(micros)$/i;
const CENTS = /(cents)$/i;
const AMOUNT = /^(amount|budget|daily_?budget|lifetime_?budget|bid|bid_?amount|max_?cpc|spend_?cap|price|unit_?amount|value)$/i;
const DAILY = /daily/i;

function numberOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const n = Number(value.replace(/[$,\s]/g, ""));
    return value.trim() && Number.isFinite(n) ? n : null;
  }
  return null;
}

/** The most a call commits in a month, in the account's currency, or null when it names no amount. */
export function monthlyAmountOf(input: Record<string, unknown>, depth = 0): number | null {
  let best: number | null = null;
  const take = (n: number | null) => {
    if (n !== null && n >= 0 && (best === null || n > best)) best = n;
  };
  for (const [key, value] of Object.entries(input)) {
    if (value && typeof value === "object" && !Array.isArray(value) && depth < 2) {
      take(monthlyAmountOf(value as Record<string, unknown>, depth + 1));
      continue;
    }
    const raw = numberOf(value);
    if (raw === null) continue;
    const amount = MICROS.test(key) ? raw / 1_000_000 : CENTS.test(key) ? raw / 100 : AMOUNT.test(key) ? raw : null;
    if (amount === null) continue;
    take(DAILY.test(key) ? amount * DAYS_PER_MONTH : amount);
  }
  return best;
}

export function formatMoney(amount: number, currency = "USD"): string {
  const whole = Math.abs(amount - Math.round(amount)) < 0.005;
  const text = whole ? Math.round(amount).toLocaleString("en-US") : amount.toFixed(2);
  return currency === "USD" ? `$${text}` : `${text} ${currency}`;
}
