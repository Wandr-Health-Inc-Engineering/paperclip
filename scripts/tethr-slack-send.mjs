#!/usr/bin/env node
// Manual outbound Slack test (Phase 2).
//
// Posts one test recommendation to #scout in the standard format, using the
// real bot token — the QUEUED "first real #scout post" gate (A3). Run only
// after SLACK_BOT_TOKEN is set (locally or on Railway). Self-contained (no TS
// import) but mirrors server/src/tethr/recommendation.ts exactly.
//
//   SLACK_BOT_TOKEN=xoxb-... node scripts/tethr-slack-send.mjs
//   SLACK_BOT_TOKEN=xoxb-... SLACK_SCOUT_CHANNEL=C0BGK29482J node scripts/tethr-slack-send.mjs
//
// Prints the Slack API response. Nothing is posted if the token is missing.

const token = (process.env.SLACK_BOT_TOKEN ?? "").trim();
const channel = (process.env.SLACK_SCOUT_CHANNEL ?? "C0BGK29482J").trim();

if (!token) {
  console.error(
    "SLACK_BOT_TOKEN is not set. Set it first (see docs/tethr-buildout/MANUAL-STEPS.md A2).",
  );
  process.exit(1);
}

const FOOTER = "Reply in-thread and tag @Cursor to fix.";
const rec = {
  agentCodename: "Sentry",
  title: "Homepage <title> is 71 characters (over the 60-char target)",
  why: "Long titles get truncated in Google results, weakening the click-through on the highest-traffic page.",
  affectedUrl: "https://travelwithwandr.com/",
  affectedPage: "/",
  filePath: "app/(marketing)/page.tsx",
  severity: "medium",
  details: ["Current: 71 chars", "Target: <= 60 chars"],
};

const sev = (rec.severity ?? "medium").toUpperCase();
const affected = [
  rec.affectedUrl ? `URL: ${rec.affectedUrl}` : null,
  rec.affectedPage ? `Page: ${rec.affectedPage}` : null,
  rec.filePath ? `File: ${rec.filePath}` : null,
].filter(Boolean);

const blocks = [
  { type: "section", text: { type: "mrkdwn", text: `*${rec.title}*` } },
  { type: "context", elements: [{ type: "mrkdwn", text: `${sev} · ${rec.agentCodename}` }] },
  { type: "section", text: { type: "mrkdwn", text: `*Why it matters*\n${rec.why}` } },
  { type: "section", text: { type: "mrkdwn", text: `*Affected*\n${affected.join("\n")}` } },
  { type: "section", text: { type: "mrkdwn", text: rec.details.map((d) => `• ${d}`).join("\n") } },
  { type: "divider" },
  { type: "context", elements: [{ type: "mrkdwn", text: FOOTER }] },
];

const res = await fetch("https://slack.com/api/chat.postMessage", {
  method: "POST",
  headers: {
    "content-type": "application/json; charset=utf-8",
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    channel,
    text: `[${sev}] ${rec.title} — ${rec.agentCodename}`,
    blocks,
  }),
});
const data = await res.json().catch(() => ({}));
console.log(JSON.stringify(data, null, 2));
if (!data.ok) {
  console.error(`Slack error: ${data.error ?? `http ${res.status}`}`);
  process.exit(1);
}
console.log(`Posted to ${data.channel} at ts=${data.ts}`);
