// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopTerminalButton } from "./DesktopTerminalButton";

describe("the desktop app's terminal icon", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;
  const realUA = navigator.userAgent;

  function setUA(ua: string) {
    Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });
  }

  function mount() {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<DesktopTerminalButton />));
  }

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    setUA(realUA);
    delete (window as unknown as { webkit?: unknown }).webkit;
  });

  it("isn't there in a plain browser", () => {
    mount();
    expect(container.querySelector("button")).toBeNull();
  });

  it("asks the app to toggle its terminal, and shows whether it's open", () => {
    const postMessage = vi.fn();
    setUA("Mozilla/5.0 TethrDesktop/1.0");
    (window as unknown as { webkit: unknown }).webkit = { messageHandlers: { tethrApp: { postMessage } } };
    mount();
    const button = container.querySelector("button")!;
    expect(button).not.toBeNull();
    expect(postMessage).toHaveBeenCalledWith({ terminal: "state" });
    act(() => button.click());
    expect(postMessage).toHaveBeenLastCalledWith({ terminal: "toggle" });
    act(() => {
      window.dispatchEvent(new CustomEvent("tethr-terminal", { detail: { open: true } }));
    });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("Hide the terminal (⌃`)");
  });
});
