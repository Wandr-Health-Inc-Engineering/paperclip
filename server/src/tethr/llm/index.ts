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

let cached: LLMProvider | null = null;

export function getTethrLLMProvider(): LLMProvider {
  if (cached) return cached;
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  cached = apiKey ? new ClaudeProvider(apiKey) : new MockProvider();
  return cached;
}

/** Test seam. */
export function setTethrLLMProvider(provider: LLMProvider | null): void {
  cached = provider;
}
