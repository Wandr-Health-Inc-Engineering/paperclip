// Browser e2e of the Sonar loop: run heartbeat from the UI → gated reply in
// the Queue → approve with a note → published file in the Drive → decision in
// the Audit log. Exits non-zero on any failed assertion.
//   node scripts/tethr-e2e.mjs   (dev stack must be running, Wandr Growth seeded)

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve("playwright", { paths: ["./node_modules/.pnpm/playwright@1.58.2/node_modules"] }));

const BASE = process.env.TETHR_UI_URL ?? "http://localhost:5173";
let failures = 0;

function check(name, condition) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}`);
  }
}

async function main() {
  const companies = await (await fetch(`${BASE}/api/companies`)).json();
  const company = companies.find((c) => c.name === "Wandr Growth");
  if (!company) throw new Error("Wandr Growth not seeded");
  const prefix = company.issuePrefix;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => localStorage.setItem("paperclip.theme", "dark"));
  const consoleErrors = [];
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  // 1. Run Sonar's heartbeat from the Runs screen.
  console.log("1. run Sonar heartbeat from the UI");
  await page.goto(`${BASE}/${prefix}/runs`);
  const sonarCard = page.locator("div", { hasText: "Sonar heartbeat" }).locator("button", { hasText: "Run now" }).first();
  await sonarCard.click();
  // The run is synchronous server-side; give it time then confirm history shows it.
  await page.waitForTimeout(8000);
  await page.reload();
  await page.waitForTimeout(2000);
  const historyText = await page.textContent("body");
  check("run history shows a Sonar on-demand run", /on_demand|Run now by/i.test(historyText ?? ""));

  // 2. The gated reply is in the Queue; open it.
  console.log("2. review the gated reply in the Queue");
  await page.goto(`${BASE}/${prefix}/queue`);
  await page.waitForTimeout(1500);
  const replyCard = page
    .locator("button", { hasText: "AWAITING REVIEW" })
    .filter({ hasText: /Reply draft/i })
    .first();
  check("a gated Reply draft awaits review", (await replyCard.count()) > 0);
  await replyCard.click();
  await page.waitForTimeout(1200);
  const detailText = await page.textContent("body");
  check("detail shows the public gate + guardrails", /public/i.test(detailText ?? "") && /guardrails/i.test(detailText ?? ""));
  check("tool trail visible on the draft", /Worked with/i.test(detailText ?? ""));

  // 3. Approve with a note.
  console.log("3. approve + publish");
  await page.fill("textarea", "e2e: zero-promo confirmed, send it.");
  await page.locator("button", { hasText: "Approve + publish" }).first().click();
  await page.waitForTimeout(2500);
  const decided = await page.textContent("body");
  check("decision record shows approval by board/mark", /Approved/i.test(decided ?? ""));
  check("published to the drive note appears", /published to the drive/i.test(decided ?? ""));

  // 4. The file landed in the Drive under /scout/replies.
  console.log("4. verify the file in the Drive");
  await page.goto(`${BASE}/${prefix}/drive`);
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "scout", exact: true }).first().click();
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: "replies", exact: true }).first().click();
  await page.waitForTimeout(1000);
  const driveText = await page.textContent("body");
  check("a reply file exists in /scout/replies", /reply/i.test(driveText ?? "") && /\.md/.test(driveText ?? ""));

  // 5. The decision is in the Audit log.
  console.log("5. verify the audit trail");
  await page.goto(`${BASE}/${prefix}/audit`);
  await page.waitForTimeout(1500);
  await page.locator("button", { hasText: "approvals" }).first().click();
  await page.waitForTimeout(1200);
  const auditText = await page.textContent("body");
  check("audit shows the approval with the reviewer note", /approved/i.test(auditText ?? "") && /zero-promo confirmed/i.test(auditText ?? ""));

  check("no uncaught page errors", consoleErrors.length === 0);
  if (consoleErrors.length) console.error("   page errors:", consoleErrors.slice(0, 3));

  await browser.close();
  console.log(failures === 0 ? "\nE2E PASSED" : `\nE2E FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
