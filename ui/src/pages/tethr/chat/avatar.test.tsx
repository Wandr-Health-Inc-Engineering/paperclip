// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TethrAgentSettings, TethrTeamAgent } from "@/api/tethr";

const settings: TethrAgentSettings = {
  tag: "@paid-ads",
  name: "Paid Ads",
  settingsFrom: null,
  connectors: ["Google Ads"],
  tools: [],
  canAdd: [],
  summary: { onItsOwn: ["Changes in Google Ads"], needsApproval: ["Anything medical"], lookOnly: [] },
  limits: { budgetMonthlyUsd: 15, maxRunsPerDay: 4, spentMonthlyUsd: 0 },
  paused: false,
  subTeam: [],
};

vi.mock("@/api/tethr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tethr")>();
  return { ...actual, tethrApi: { ...actual.tethrApi, agentSettings: vi.fn(async () => settings) } };
});
vi.mock("../../../lib/router", () => ({ Link: ({ children }: { children: unknown }) => children, useNavigate: () => vi.fn() }));

const { ChatAvatar } = await import("./avatar");

const agent = {
  agentId: "a1",
  tag: "@paid-ads",
  name: "Paid Ads",
  title: "Paid search lead",
  mission: "Owns paid search.",
  icon: "target",
  paused: false,
  threadId: "t1",
  lead: true,
  leadTag: null,
  subTeam: [],
  goal: null,
  connectors: ["Google Ads"],
  schedule: null,
  ownerRole: "growth",
  ownerName: null,
  maxRunsPerDay: 4,
  runsToday: 0,
  openTasks: 0,
  running: false,
  waitingOnYou: 0,
  waitingFor: [],
  lastReportAt: null,
  budgetMonthlyCents: 1500,
  spentMonthlyCents: 0,
} as TethrTeamAgent;

describe("an agent's settings from its avatar", () => {
  let root: Root | null = null;
  let host: HTMLDivElement;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
  });

  // The avatar's popover closes on any click outside it, and the sheet is drawn on
  // the page (outside it): owned by the popover, a click in the sheet closed it.
  it("opens the sheet, and a click inside the sheet leaves it open", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root!.render(
        <QueryClientProvider client={new QueryClient()}>
          <ChatAvatar working={false} agent={agent} companyId="c1" />
        </QueryClientProvider>,
      ),
    );
    await act(async () => (host.querySelector("button.tethr-avatar") as HTMLButtonElement).click());
    const open = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Settings")!;
    await act(async () => open.click());
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    const sheet = document.querySelector('[role="dialog"]')!;
    expect(sheet).not.toBeNull();
    await act(async () => {
      sheet.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      sheet.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Paid Ads's settings");
  });
});
