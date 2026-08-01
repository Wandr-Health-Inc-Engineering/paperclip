#!/usr/bin/env node
// One-off cleanup: delete the test-fixture messages Tethr's test suite
// accidentally posted to #scout on 2026-07-10 (a real SLACK_BOT_TOKEN leaked
// into the test env before the fix). SAFETY: only deletes the bot's OWN
// messages whose text matches the known test fixtures — it never touches a
// human message or any message that doesn't match. Dry-run by default.
//
//   SLACK_BOT_TOKEN=xoxb-... node scripts/tethr-slack-cleanup.mjs          # preview
//   SLACK_BOT_TOKEN=xoxb-... node scripts/tethr-slack-cleanup.mjs --apply  # delete

const token = (process.env.SLACK_BOT_TOKEN ?? "").trim();
const channel = (process.env.SLACK_SCOUT_CHANNEL ?? "C0BGK29482J").trim();
const apply = process.argv.includes("--apply");
if (!token) {
  console.error("Set SLACK_BOT_TOKEN (temporarily) to run the cleanup.");
  process.exit(1);
}

// Exact fragments from the deterministic test fixtures — nothing real matches these.
const FIXTURE_MARKERS = [
  "staged medical-sensitive output for review",
  "staged public-facing output for review",
  "staged spend-sensitive output for review",
  "staged PR-sensitive output for review",
  "Altitude sickness prevention for Cusco",
  "Reply draft — travel-health questions",
  "Ads recommendation: Travel Consult",
  "Wandr partners with Andean Trails",
];

async function api(method, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  return res.json();
}

const hist = await api("conversations.history", { channel, limit: 200 });
if (!hist.ok) {
  console.error(`conversations.history failed: ${hist.error} (needs channels:history + the bot in #scout)`);
  process.exit(1);
}
const targets = (hist.messages ?? []).filter(
  (m) => m.bot_id && typeof m.text === "string" && FIXTURE_MARKERS.some((f) => m.text.includes(f)),
);
console.log(`Found ${targets.length} test-fixture message(s) posted by the bot.\n`);
let deleted = 0;
for (const m of targets) {
  const preview = String(m.text).split("\n")[0].slice(0, 80);
  if (!apply) {
    console.log(`would delete: ${preview}`);
    continue;
  }
  const del = await api("chat.delete", { channel, ts: m.ts });
  if (del.ok) {
    deleted++;
    console.log(`deleted: ${preview}`);
  } else {
    console.error(`FAILED (${del.error}): ${preview}`);
  }
  await new Promise((r) => setTimeout(r, 400)); // gentle on rate limits
}
console.log(apply ? `\nDone — deleted ${deleted}/${targets.length}.` : `\nDry run. Re-run with --apply to delete.`);
