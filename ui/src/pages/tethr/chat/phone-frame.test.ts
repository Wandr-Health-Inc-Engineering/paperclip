import { describe, expect, it } from "vitest";
import { phoneFrame } from "./phone-frame";

// An iPhone-sized screen: 812 tall, the top bar ends at 64, no bottom tabs.
const closed = { innerHeight: 812, viewportTop: 0, viewportHeight: 812, anchorTop: 64, navTop: null };

describe("phoneFrame", () => {
  it("runs from under the top bar to the bottom of the screen", () => {
    expect(phoneFrame(closed)).toEqual({ top: 64, height: 748, keyboard: false });
  });

  it("stops above bottom tabs when a layout has them", () => {
    expect(phoneFrame({ ...closed, navTop: 747 })).toEqual({ top: 64, height: 683, keyboard: false });
  });

  it("fills the visible area above the keyboard, wherever Safari has panned it", () => {
    expect(phoneFrame({ ...closed, viewportTop: 300, viewportHeight: 470 })).toEqual({ top: 300, height: 470, keyboard: true });
  });

  it("ignores a small change in the visible area (Safari's toolbar), and keeps a usable height", () => {
    expect(phoneFrame({ ...closed, viewportHeight: 760 })).toEqual({ top: 64, height: 696, keyboard: false });
    expect(phoneFrame({ ...closed, anchorTop: 700 })).toEqual({ top: 700, height: 240, keyboard: false });
  });
});
