import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  denyRulesFor,
  getIntegrations,
  integrationRulesText,
  modeFor,
  recordDiscoveredTools,
  sanitizeIntegrationsPatch,
  updateIntegrations,
} from "../tethr/integrations.js";

// Phase 18.4: the Integrations config behind the chat's approval gate.

const C = "7c92c0f9-8ab4-4cb5-aa88-f01ef5dd0705";
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-integrations-"));
  process.env.TETHR_INTEGRATIONS_FILE = path.join(dir, "integrations.json");
});
afterEach(() => {
  delete process.env.TETHR_INTEGRATIONS_FILE;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("tethr integrations config", () => {
  it("defaults: approval required, money/design connectors off, session engine", () => {
    const cfg = getIntegrations(C);
    expect(cfg.defaultMode).toBe("ask");
    expect(modeFor(cfg, "Gmail")).toBe("ask");
    expect(modeFor(cfg, "Mercury")).toBe("off");
    expect(modeFor(cfg, "Canva")).toBe("off");
    expect(cfg.assistant).toEqual({ engine: "session", model: "sonnet" });
    expect(cfg.internalAddresses).toEqual(["travelwithwandr.com"]);
  });

  it("turns Off connectors into deny rules (plus the stray posthog server)", () => {
    expect(denyRulesFor(getIntegrations(C)).sort()).toEqual(
      ["mcp__claude_ai_Canva", "mcp__claude_ai_Figma", "mcp__claude_ai_Mercury", "mcp__posthog"].sort(),
    );
  });

  it("sanitizes updates: unknown modes dropped, Mercury never Auto, addresses tidied", () => {
    const patch = sanitizeIntegrationsPatch({
      defaultMode: "yolo",
      connectors: { Gmail: { mode: "auto", scope: "Only Wandr/* labels" }, Mercury: { mode: "auto" }, Slack: { mode: "nope" } },
      internalAddresses: [" Mark@TravelWithWandr.com ", 42, ""],
      shell: "always",
      assistant: { engine: "routing", model: "opus; rm -rf" },
    });
    expect(patch.defaultMode).toBeUndefined();
    expect(patch.connectors).toEqual({ Gmail: { mode: "auto", scope: "Only Wandr/* labels" }, Mercury: { mode: "ask" } });
    expect(patch.internalAddresses).toEqual(["mark@travelwithwandr.com"]);
    expect(patch.shell).toBeUndefined();
    expect(patch.assistant).toEqual({ engine: "routing" });
  });

  it("persists per company and caps Mercury at ask even if stored as auto", async () => {
    await updateIntegrations(C, { connectors: { Gmail: { mode: "auto" }, Mercury: { mode: "auto" } } });
    const cfg = getIntegrations(C);
    expect(modeFor(cfg, "Gmail")).toBe("auto");
    expect(modeFor(cfg, "Mercury")).toBe("ask");
    expect(modeFor(cfg, "Canva")).toBe("off");
    expect(getIntegrations("00000000-0000-4000-8000-000000000000").connectors.Gmail).toBeUndefined();
  });

  it("writes scope notes and off connectors into the workspace rules", async () => {
    await updateIntegrations(C, { connectors: { Slack: { mode: "read", scope: "Only #growth and #tethr." } } });
    const text = integrationRulesText(getIntegrations(C));
    expect(text).toContain("- Slack: Only #growth and #tethr.");
    expect(text).toMatch(/Turned off: .*Mercury/);
    expect(text).toContain("Inside the company: travelwithwandr.com");
  });

  it("remembers connector tool names seen on real turns", async () => {
    await recordDiscoveredTools(C, [
      "mcp__claude_ai_Gmail__search_threads",
      "mcp__claude_ai_Gmail__send_message",
      "mcp__claude_ai_Google_Calendar__list_events",
      "Read",
    ]);
    await recordDiscoveredTools(C, ["mcp__claude_ai_Gmail__search_threads"]);
    expect(getIntegrations(C).discovered?.connectors).toEqual({
      Gmail: ["search_threads", "send_message"],
      "Google Calendar": ["list_events"],
    });
  });
});
