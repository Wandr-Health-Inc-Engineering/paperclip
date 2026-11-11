import { describe, expect, it } from "vitest";
import { parseEnvPaste, pasteConfirmText } from "./TethrEnv";

describe("Environment page: pasting several settings", () => {
  it("reads KEY=value lines, quotes and comments", () => {
    expect(parseEnvPaste("# note\nA=1\nexport B='two words'\nC=x # trailing\n\nnot a line")).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "two words" },
      { key: "C", value: "x" },
    ]);
  });

  it("says which settings are new, which get replaced, and which tethr depends on", () => {
    const text = pasteConfirmText(
      [{ key: "TYPESAFE_API_KEY" }, { key: "SLACK_BOT_TOKEN" }, { key: "DATABASE_URL" }, { key: "BETTER_AUTH_SECRET" }],
      new Set(["SLACK_BOT_TOKEN", "DATABASE_URL"]),
    );
    expect(text).toContain("Save these 4 settings?");
    expect(text).toContain("New: TYPESAFE_API_KEY, BETTER_AUTH_SECRET");
    expect(text).toContain("Replaces the current value of: SLACK_BOT_TOKEN, DATABASE_URL");
    expect(text).toContain("tethr itself depends on DATABASE_URL, BETTER_AUTH_SECRET");
  });

  it("stays short when nothing is replaced and nothing is core", () => {
    expect(pasteConfirmText([{ key: "A" }, { key: "B" }], new Set())).toBe("Save these 2 settings?\n\nNew: A, B");
  });
});
