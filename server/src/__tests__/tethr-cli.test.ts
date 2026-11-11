import { describe, it, expect } from "vitest";
// The terminal client is a zero-dependency root script; we only exercise its
// PURE helpers here (no I/O, no REPL) — the guarded `main()` never runs on import.
import {
  parseCommand,
  renderMarkdown,
  formatHop,
  isLoopbackUrl,
  redactToken,
  truncate,
} from "../../../scripts/tethr-cli.mjs";

describe("tethr-cli parseCommand", () => {
  it("returns null for a plain message", () => {
    expect(parseCommand("what bugs do I need to fix?")).toBeNull();
    expect(parseCommand("  hello there ")).toBeNull();
  });

  it("parses a bare command", () => {
    expect(parseCommand("/queue")).toMatchObject({ name: "queue", arg: null, note: null });
  });

  it("splits a command with an index and a note", () => {
    const cmd = parseCommand("/approve 2 looks good to me");
    expect(cmd).toMatchObject({ name: "approve", arg: "2", note: "looks good to me" });
  });

  it("lowercases the command name", () => {
    expect(parseCommand("/STATUS")?.name).toBe("status");
  });
});

describe("tethr-cli renderMarkdown (plain mode strips markers)", () => {
  it("strips heading hashes", () => {
    expect(renderMarkdown("# Title")).toBe("Title");
    expect(renderMarkdown("### Deep")).toBe("Deep");
  });

  it("turns bullets into a dot glyph", () => {
    expect(renderMarkdown("- item one")).toBe("• item one");
    expect(renderMarkdown("  * nested")).toBe("  • nested");
  });

  it("unwraps bold and inline code", () => {
    expect(renderMarkdown("this is **bold** and `code`")).toBe("this is bold and code");
  });

  it("rewrites links as text (url)", () => {
    expect(renderMarkdown("see [the docs](https://x.dev)")).toBe("see the docs (https://x.dev)");
  });

  it("drops code-fence markers but keeps the code lines", () => {
    const out = renderMarkdown("```js\nconst x = 1;\n```");
    expect(out).toContain("const x = 1;");
    expect(out).not.toContain("```");
  });

  it("is null/undefined safe", () => {
    expect(renderMarkdown(undefined)).toBe("");
  });
});

describe("tethr-cli formatHop", () => {
  it("includes the actor tag, decision, and reason", () => {
    const line = formatHop({ layer: "agent", actorTag: "@tethr", decision: "route→chat", reason: "answer directly" });
    expect(line).toContain("@tethr");
    expect(line).toContain("route→chat");
    expect(line).toContain("answer directly");
  });

  it("truncates a very long reason", () => {
    const line = formatHop({ layer: "tool", actorTag: "@radar.scan", decision: "web_fetch", reason: "x".repeat(200) });
    expect(line).toContain("…");
    expect(line.length).toBeLessThan(160);
  });
});

describe("tethr-cli isLoopbackUrl", () => {
  it("treats localhost variants as loopback", () => {
    expect(isLoopbackUrl("http://localhost:3100")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.1:3100")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:3100")).toBe(true);
  });

  it("treats a tailnet/LAN/public host as remote (warn)", () => {
    expect(isLoopbackUrl("http://100.101.102.103:3100")).toBe(false); // Tailscale IP
    expect(isLoopbackUrl("http://192.168.1.50:3100")).toBe(false); // LAN
    expect(isLoopbackUrl("https://tethr.example.com")).toBe(false);
  });
});

describe("tethr-cli redactToken", () => {
  it("replaces the token wherever it appears", () => {
    expect(redactToken("Bearer sk-abc123 failed", "sk-abc123")).toBe("Bearer [redacted] failed");
  });

  it("is a no-op without a token", () => {
    expect(redactToken("nothing to hide", null)).toBe("nothing to hide");
  });
});

describe("tethr-cli truncate", () => {
  it("caps long strings with an ellipsis", () => {
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
  });
  it("leaves short strings alone", () => {
    expect(truncate("abc", 10)).toBe("abc");
  });
});
