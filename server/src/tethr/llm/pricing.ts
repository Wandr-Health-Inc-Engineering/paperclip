// Token → USD pricing for Tethr live-LLM cost accounting (Phase 3).
//
// Without this, the tethr_llm adapter reported no per-run cost, so every
// `cost_events` row recorded 0 cents and the budget hard-stops could never
// trip — the per-agent caps were unenforceable. This prices a run's token
// usage so real spend flows into core budget_policies + cost_events.
//
// Rates are USD per 1,000,000 tokens. The authoritative source is
// console.anthropic.com; these are the published rates as of 2026-07 and can
// be overridden per-deploy with TETHR_PRICE_INPUT_PER_MTOK /
// TETHR_PRICE_OUTPUT_PER_MTOK (no code change) if they drift. The org-level
// Anthropic spend limit remains the real backstop regardless of this estimate.

export interface ModelRate {
  inputPerMTok: number;
  outputPerMTok: number;
}

// Published rates (USD / 1M tokens), 2026-07.
const RATES: Record<string, ModelRate> = {
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
};

// Unknown live model → Sonnet-class rate, so cost is never silently zero.
const FALLBACK: ModelRate = { inputPerMTok: 3, outputPerMTok: 15 };

export function rateForModel(model: string): ModelRate {
  const envIn = Number(process.env.TETHR_PRICE_INPUT_PER_MTOK);
  const envOut = Number(process.env.TETHR_PRICE_OUTPUT_PER_MTOK);
  if (
    Number.isFinite(envIn) &&
    Number.isFinite(envOut) &&
    envIn >= 0 &&
    envOut >= 0 &&
    (process.env.TETHR_PRICE_INPUT_PER_MTOK ?? "") !== "" &&
    (process.env.TETHR_PRICE_OUTPUT_PER_MTOK ?? "") !== ""
  ) {
    return { inputPerMTok: envIn, outputPerMTok: envOut };
  }
  // Tolerate a dated snapshot suffix (e.g. "-20251114").
  const bare = (model ?? "").replace(/-\d{8}$/, "");
  return RATES[model] ?? RATES[bare] ?? FALLBACK;
}

/** USD cost for a token-usage delta at a model's rate. */
export function priceUsd(
  model: string,
  usage: { inputTokens: number; outputTokens: number },
): number {
  const rate = rateForModel(model);
  const input = Math.max(0, usage?.inputTokens ?? 0);
  const output = Math.max(0, usage?.outputTokens ?? 0);
  return (input * rate.inputPerMTok + output * rate.outputPerMTok) / 1_000_000;
}
