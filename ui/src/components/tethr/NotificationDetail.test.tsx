// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TethrNotification } from "@/api/tethr";
import { NotificationDetail } from "./TethrBell";

vi.mock("../../lib/router", () => ({ useNavigate: () => vi.fn() }));

const notification: TethrNotification = {
  id: "n1",
  kind: "system",
  title: "Someone wrote to tethr in Slack",
  body: "U123 isn't linked to a person in tethr.",
  href: "/setup?step=connect",
  agentTag: "@tethr",
  readAt: null,
  createdAt: "2026-11-10T16:00:00.000Z",
};

describe("the notification detail", () => {
  let root: Root | null = null;
  let bar: HTMLDivElement;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    bar?.remove();
  });

  // The top bar has a backdrop blur, so a fixed card drawn inside it is laid out in
  // the bar's 48px box (cut off above the screen) and can't blur the page behind it.
  it("is drawn on the page, not inside the top bar it was opened from", () => {
    bar = document.createElement("div");
    document.body.appendChild(bar);
    root = createRoot(bar);
    act(() =>
      root!.render(
        <QueryClientProvider client={new QueryClient()}>
          <NotificationDetail notification={notification} companyId="c1" onClose={() => {}} onActed={() => {}} />
        </QueryClientProvider>,
      ),
    );
    const card = document.querySelector('[data-testid="notification-detail"]');
    expect(card).not.toBeNull();
    expect(card!.parentElement).toBe(document.body);
    expect(bar.contains(card)).toBe(false);
    expect(card!.textContent).toContain("Someone wrote to tethr in Slack");
  });
});
