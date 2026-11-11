import { describe, expect, it } from "vitest";
import { enterSends } from "./tethr-composer";

const key = (over: Partial<{ key: string; shiftKey: boolean; isComposing: boolean }> = {}) => ({
  key: over.key ?? "Enter",
  shiftKey: over.shiftKey ?? false,
  nativeEvent: { isComposing: over.isComposing ?? false },
});

describe("when Enter sends", () => {
  it("sends on a computer", () => {
    expect(enterSends(key(), false)).toBe(true);
  });

  // Mark, 2026-11-10: "if I hit enter or return on my phone it submits instead of new line".
  it("makes a new line on a phone", () => {
    expect(enterSends(key(), true)).toBe(false);
  });

  it("never sends with Shift, mid-composition, or for another key", () => {
    expect(enterSends(key({ shiftKey: true }), false)).toBe(false);
    expect(enterSends(key({ isComposing: true }), false)).toBe(false);
    expect(enterSends(key({ key: "a" }), false)).toBe(false);
  });
});
