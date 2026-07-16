import { ClaudeProvider } from "./claude.js";
import { ClaudeCodeProvider } from "./claude-code.js";
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

/** Which live backend the env selects: the Anthropic API (key) or the Claude
 * Code CLI (personal subscription). Defaults to `api`. */
export type TethrLlmBackend = "api" | "claude-code";
export function getTethrLlmBackend(): TethrLlmBackend {
  return process.env.TETHR_LLM_BACKEND?.trim() === "claude-code" ? "claude-code" : "api";
}

/** Is a live Claude key available at all? (The API backend needs it.) */
export function tethrLiveKeyPresent(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

/** Can we run live at all? True if the Claude Code backend is selected, OR an
 * API key is present. Without either, only the mock is possible. */
export function tethrLiveAvailable(): boolean {
  return getTethrLlmBackend() === "claude-code" || tethrLiveKeyPresent();
}

/** The env-declared default before any runtime override. */
function envDefaultMode(): TethrLlmMode {
  return tethrLiveAvailable() ? "live" : "mock";
}

/** The mode in effect right now — a runtime override wins over the env default. */
export function getTethrLlmMode(): TethrLlmMode {
  return override ?? envDefaultMode();
}

export function getTethrLLMProvider(): LLMProvider {
  if (cached) return cached;
  if (getTethrLlmMode() === "live") {
    if (getTethrLlmBackend() === "claude-code") {
      // Personal subscription via the Claude Code CLI — no API key needed.
      cached = new ClaudeCodeProvider();
      return cached;
    }
    const key = process.env.ANTHROPIC_API_KEY?.trim();
    if (key) {
      cached = new ClaudeProvider(key);
      return cached;
    }
  }
  cached = new MockProvider();
  return cached;
}

/**
 * Flip the whole instance between live Claude and the deterministic mock at
 * runtime (the Providers-page toggle). In-memory only — resets to the env
 * default on restart. Going "live" requires ANTHROPIC_API_KEY; without it this
 * throws and the mode is left unchanged. Returns the mode now in effect.
 */
export function setTethrLlmMode(mode: TethrLlmMode): TethrLlmMode {
  if (mode === "live" && !tethrLiveAvailable()) {
    throw new Error(
      "No live backend available — set ANTHROPIC_API_KEY, or TETHR_LLM_BACKEND=claude-code with the Claude Code CLI installed.",
    );
  }
  override = mode;
  cached = null; // rebuild the provider on next use
  return getTethrLlmMode();
}

/** Test seam. */
export function setTethrLLMProvider(provider: LLMProvider | null): void {
  cached = provider;
}
