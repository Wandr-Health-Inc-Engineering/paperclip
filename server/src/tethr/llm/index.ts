import { ClaudeProvider } from "./claude.js";
import { MockProvider } from "./mock.js";
import type { LLMProvider } from "./types.js";

export type { LLMProvider } from "./types.js";
export type {
  ClassifyInput,
  ClassifyOption,
  ClassifyResult,
  GenerateInput,
  GenerateResult,
  LLMUsage,
} from "./types.js";
export { MockProvider } from "./mock.js";
export { ClaudeProvider } from "./claude.js";

export type TethrLlmMode = "live" | "mock";

let cached: LLMProvider | null = null;
// Runtime override set from the Providers page. In-memory only: on restart the
// instance falls back to the env-declared default (below). null = follow env.
let override: TethrLlmMode | null = null;

/** Is a live Claude key available at all? Live mode is impossible without it. */
export function tethrLiveKeyPresent(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

/** The env-declared default before any runtime override. */
function envDefaultMode(): TethrLlmMode {
  return tethrLiveKeyPresent() ? "live" : "mock";
}

/** The mode in effect right now — a runtime override wins over the env default. */
export function getTethrLlmMode(): TethrLlmMode {
  return override ?? envDefaultMode();
}

export function getTethrLLMProvider(): LLMProvider {
  if (cached) return cached;
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  cached =
    getTethrLlmMode() === "live" && key ? new ClaudeProvider(key) : new MockProvider();
  return cached;
}

/**
 * Flip the whole instance between live Claude and the deterministic mock at
 * runtime (the Providers-page toggle). In-memory only — resets to the env
 * default on restart. Going "live" requires ANTHROPIC_API_KEY; without it this
 * throws and the mode is left unchanged. Returns the mode now in effect.
 */
export function setTethrLlmMode(mode: TethrLlmMode): TethrLlmMode {
  if (mode === "live" && !tethrLiveKeyPresent()) {
    throw new Error("ANTHROPIC_API_KEY is not set — cannot switch to live Claude.");
  }
  override = mode;
  cached = null; // rebuild the provider on next use
  return getTethrLlmMode();
}

/** Test seam. */
export function setTethrLLMProvider(provider: LLMProvider | null): void {
  cached = provider;
}
