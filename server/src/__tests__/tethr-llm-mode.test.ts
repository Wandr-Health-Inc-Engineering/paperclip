import { afterEach, describe, it, expect } from "vitest";
import {
  getTethrLlmMode,
  getTethrLLMProvider,
  setTethrLlmMode,
  setTethrLLMProvider,
  tethrLiveKeyPresent,
} from "../tethr/llm/index.js";

// The Providers-page toggle: a runtime switch between live Claude and the
// deterministic mock. These lock the seam the endpoint drives so the toggle
// stays a real provider swap, not a cosmetic badge.

const KEY = "ANTHROPIC_API_KEY";
const savedKey = process.env[KEY];

function withKey(value: string | undefined) {
  if (value === undefined) delete process.env[KEY];
  else process.env[KEY] = value;
}

describe("Tethr LLM runtime mode", () => {
  afterEach(() => {
    // Restore the process env + a known provider state between cases.
    withKey(savedKey);
    setTethrLLMProvider(null);
  });

  it("reports live-key presence straight from the env", () => {
    withKey("sk-ant-test-key");
    expect(tethrLiveKeyPresent()).toBe(true);
    withKey(undefined);
    expect(tethrLiveKeyPresent()).toBe(false);
  });

  it("forces the mock provider even when a live key is present", () => {
    withKey("sk-ant-test-key");
    setTethrLLMProvider(null);

    setTethrLlmMode("live");
    expect(getTethrLlmMode()).toBe("live");
    expect(getTethrLLMProvider().id).toBe("claude");

    expect(setTethrLlmMode("mock")).toBe("mock");
    expect(getTethrLlmMode()).toBe("mock");
    expect(getTethrLLMProvider().id).toBe("mock");
  });

  it("refuses to go live without a key and leaves the mode unchanged", () => {
    withKey(undefined);
    setTethrLLMProvider(null);
    setTethrLlmMode("mock");

    expect(() => setTethrLlmMode("live")).toThrow(/ANTHROPIC_API_KEY/);
    expect(getTethrLlmMode()).toBe("mock");
    expect(getTethrLLMProvider().id).toBe("mock");
  });
});
