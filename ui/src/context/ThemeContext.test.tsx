// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme } from "./ThemeContext";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// A controllable prefers-color-scheme media query.
function installMatchMedia(initialDark: boolean) {
  let dark = initialDark;
  const listeners = new Set<() => void>();
  const query = {
    get matches() {
      return dark;
    },
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  vi.stubGlobal("matchMedia", vi.fn(() => query));
  window.matchMedia = globalThis.matchMedia;
  return {
    setDark(next: boolean) {
      dark = next;
      listeners.forEach((fn) => fn());
    },
  };
}

describe("ThemeContext (Auto / Day / Night)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let api: ReturnType<typeof useTheme> | null = null;

  function Probe() {
    api = useTheme();
    return null;
  }

  function mount() {
    act(() => {
      root.render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      );
    });
  }

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("dark");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    api = null;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("defaults to Auto and follows the device setting live", () => {
    const device = installMatchMedia(false);
    mount();
    expect(api!.preference).toBe("system");
    expect(api!.theme).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    act(() => device.setDark(true));
    expect(api!.theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("paperclip.theme")).toBe("system");
  });

  it("Day and Night override the device and persist", () => {
    const device = installMatchMedia(true);
    mount();
    act(() => api!.setPreference("light"));
    expect(api!.theme).toBe("light");
    expect(localStorage.getItem("paperclip.theme")).toBe("light");

    act(() => device.setDark(false));
    act(() => device.setDark(true));
    expect(api!.theme).toBe("light");

    act(() => api!.setPreference("dark"));
    expect(api!.theme).toBe("dark");
    expect(localStorage.getItem("paperclip.theme")).toBe("dark");
  });

  it("restores a stored explicit choice and keeps the old toggle API working", () => {
    installMatchMedia(true);
    localStorage.setItem("paperclip.theme", "light");
    mount();
    expect(api!.preference).toBe("light");
    expect(api!.theme).toBe("light");

    act(() => api!.toggleTheme());
    expect(api!.preference).toBe("dark");
    expect(api!.theme).toBe("dark");
  });
});
