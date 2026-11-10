import { describe, expect, it } from "vitest";
import { phoneFrame } from "./phone-frame";

// An iPhone-sized screen: 812 tall, the top bar ends at 64, the tabs start at 747.
const closed = { innerHeight: 812, viewportTop: 0, viewportHeight: 812, anchorTop: 64, navTop: 747 };

describe("phoneFrame", () => {
  it("sits between the top bar and the tabs", () => {
    expect(phoneFrame(closed)).toEqual({ top: 64, height: 683 });
  });

  it("fills the visible area above the keyboard, wherever Safari has panned it", () => {
    expect(phoneFrame({ ...closed, viewportTop: 300, viewportHeight: 470 })).toEqual({ top: 300, height: 470 });
  });

  it("ignores a small change in the visible area (Safari's toolbar), and keeps a usable height", () => {
    expect(phoneFrame({ ...closed, viewportHeight: 760, navTop: null })).toEqual({ top: 64, height: 696 });
    expect(phoneFrame({ ...closed, anchorTop: 700 })).toEqual({ top: 700, height: 240 });
  });
});
