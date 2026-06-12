// Captures the labeled Tethr screenshot deliverable into ~/Desktop/tethr-screenshots/.
// Requires the dev stack running (server :3100, vite :5173) with Wandr Growth seeded.
//   node scripts/tethr-screenshots.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve("playwright", { paths: ["./node_modules/.pnpm/playwright@1.58.2/node_modules"] }));

const BASE = process.env.TETHR_UI_URL ?? "http://localhost:5173";
const OUT = path.join(os.homedir(), "Desktop", "tethr-screenshots");
fs.mkdirSync(OUT, { recursive: true });

const captured = [];

async function getCompany() {
  const res = await fetch(`${BASE}/api/companies`);
  const companies = await res.json();
  const company = companies.find((c) => c.name === "Wandr Growth");
  if (!company) throw new Error("Wandr Growth not seeded — run the server once first");
  return company;
}

async function getSonarAgentId(companyId) {
  const res = await fetch(`${BASE}/api/tethr/${companyId}/overview`);
  const overview = await res.json();
  return overview.agents.find((a) => a.profile.tag === "@sonar")?.agent.id;
}

async function shoot(page, file, caption) {
  await page.screenshot({ path: path.join(OUT, file), fullPage: false });
  captured.push({ file, caption });
  console.log("captured", file);
}

async function settle(page, ms = 2600) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(ms);
}

async function run() {
  const company = await getCompany();
  const prefix = company.issuePrefix;
  const sonarId = await getSonarAgentId(company.id);
  const browser = await chromium.launch();

  for (const theme of ["light", "dark"]) {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: theme,
    });
    await ctx.addInitScript((t) => {
      localStorage.setItem("paperclip.theme", t);
      localStorage.setItem("paperclip.sidebar", "open");
    }, theme);
    const page = await ctx.newPage();
    const go = async (route, ms) => {
      await page.goto(`${BASE}/${prefix}${route}`);
      await settle(page, ms);
    };
    const t = theme;

    // 01 — Console idle (hero)
    await go("/console");
    await shoot(page, `01-console-${t}.png`, "Console — the hero screen, ask the company");

    // 02 — Console with a routed request (replay the latest from history)
    const history = page.locator("button", { hasText: "·" }).filter({ hasText: "AGO" });
    if (await history.count()) {
      await history.first().click();
      await page.waitForTimeout(2800);
      await shoot(
        page,
        `02-console-routing-${t}.png`,
        "Console — Helm classify → agent route → subagent do, with the gated result",
      );
    }

    // 03 — Company org view
    await go("/company-view");
    await shoot(
      page,
      `03-company-org-${t}.png`,
      "Company — CEO → Growth division (Helm + 8 agents + subagents) + ready-to-fill shells",
    );

    // 04 — Queue list + detail
    await go("/queue");
    await shoot(page, `04-queue-${t}.png`, "Queue — gated outputs awaiting human review");
    const card = page.locator("button", { hasText: "AWAITING REVIEW" }).first();
    if (await card.count()) {
      await card.click();
      await settle(page, 1500);
      await shoot(
        page,
        `05-queue-decision-${t}.png`,
        "Queue — full preview, guardrails, and the approve / reject / request-changes panel",
      );
    }

    // 06 — Drive root + spec file
    await go("/drive");
    await shoot(page, `06-drive-${t}.png`, "Drive — the versioned source of truth");
    for (const name of ["agents", "helm", "sonar"]) {
      const folder = page.getByRole("button", { name, exact: true }).first();
      if (await folder.count()) {
        await folder.click();
        await page.waitForTimeout(1400);
      }
    }
    const roleFile = page.locator("button", { hasText: "ROLE.md" }).first();
    if (await roleFile.count()) {
      await roleFile.click();
      await settle(page, 1500);
      await shoot(
        page,
        `07-drive-file-versions-${t}.png`,
        "Drive — Sonar's ROLE.md from the bundle, with versions, tags, permissions",
      );
    }

    // 08 — Runs
    await go("/runs");
    await shoot(page, `08-runs-heartbeats-${t}.png`, "Runs — cron schedule + history + run-now");

    // 09 — Budgets
    await go("/budgets");
    await shoot(
      page,
      `09-budgets-${t}.png`,
      "Budgets — combined growth line, per-agent caps, Tailwind hard stop, 30-day spend",
    );

    // 10 — Audit
    await go("/audit");
    await shoot(page, `10-audit-${t}.png`, "Audit — every hop, run, output, and decision");

    // 11 — Sonar agent detail
    if (sonarId) {
      await go(`/crew/${sonarId}`);
      await shoot(
        page,
        `11-agent-sonar-${t}.png`,
        "Agent detail — Sonar: mission, gate, routing table, fine-tuned subagents",
      );
    }

    // 12 — Tethr settings
    await go("/tethr-settings");
    await shoot(
      page,
      `12-settings-providers-${t}.png`,
      "Settings — provider seams (LLM / storage / DB / notifications) + engine SHA",
    );

    // 13 — Task board (core issues, reskinned)
    await go("/issues");
    await shoot(page, `13-task-board-${t}.png`, "Task board — hierarchical issues tracing to the goal");

    await ctx.close();
  }

  // Mobile set (dark)
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: "dark",
  });
  await mobile.addInitScript(() => localStorage.setItem("paperclip.theme", "dark"));
  const mp = await mobile.newPage();
  for (const [route, file, caption] of [
    ["/console", "14-mobile-console-dark.png", "Mobile — Console"],
    ["/queue", "15-mobile-queue-dark.png", "Mobile — Queue"],
    ["/company-view", "16-mobile-company-dark.png", "Mobile — Company org"],
    ["/budgets", "17-mobile-budgets-dark.png", "Mobile — Budgets"],
  ]) {
    await mp.goto(`${BASE}/${prefix}${route}`);
    await settle(mp, 2200);
    await shoot(mp, file, caption);
  }
  await mobile.close();
  await browser.close();

  // Index
  const lines = [
    "# Tethr screenshots",
    "",
    "Captured from the running local product (Wandr Growth seeded). Light + dark,",
    "desktop (1440×900) + mobile (390×844).",
    "",
    ...captured.map((c) => `- \`${c.file}\` — ${c.caption}`),
    "",
  ];
  fs.writeFileSync(path.join(OUT, "00-INDEX.md"), lines.join("\n"));
  console.log(`\n${captured.length} screenshots + 00-INDEX.md → ${OUT}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
