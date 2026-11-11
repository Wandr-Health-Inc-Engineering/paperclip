import { describe, expect, it } from "vitest";
import { staysPutOnFirstRun } from "./SetupNavItem";

describe("where a first run is sent to setup from", () => {
  it("any page but the setup itself and a link to one particular chat", () => {
    expect(staysPutOnFirstRun("/WD/dashboard", "")).toBe(false);
    expect(staysPutOnFirstRun("/WD/chat", "")).toBe(false);
    expect(staysPutOnFirstRun("/WD/growth", "")).toBe(false);
    expect(staysPutOnFirstRun("/WD/setup", "")).toBe(true);
    expect(staysPutOnFirstRun("/WD/setup", "?step=connect")).toBe(true);
    expect(staysPutOnFirstRun("/WD/chat", "?chat=0b0a0c0d-0000-4000-8000-000000000001")).toBe(true);
    // A page whose name only starts like one of them isn't one of them.
    expect(staysPutOnFirstRun("/WD/chatter", "?chat=x")).toBe(false);
    expect(staysPutOnFirstRun("/WD/setups", "")).toBe(false);
  });
});
