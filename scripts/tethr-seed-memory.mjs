#!/usr/bin/env node
// Idempotent published-content memory seed (Phase 6).
//
// Reads the blueprint corpus (memory-published-articles.md) and POSTs it to the
// Tethr seed-memory endpoint; the server parses it and records one
// `published-content` memory per item, SKIPPING any fingerprint it already has —
// so re-running is safe. After this backfill, gating auto-records every new
// publish, and routing warns on duplicate-topic content requests.
//
//   TETHR_COMPANY_ID=<id> TETHR_BASE_URL=https://<railway-url> \
//   node scripts/tethr-seed-memory.mjs /path/to/memory-published-articles.md
//
// Base URL defaults to http://localhost:3100. Company id is required
// (find it in the URL when viewing the company, or the API companies list).

import fs from "node:fs";

const base = (process.env.TETHR_BASE_URL ?? "http://localhost:3100").replace(/\/$/, "");
const companyId = process.env.TETHR_COMPANY_ID;
const seedPath = process.argv[2] ?? process.env.TETHR_MEMORY_SEED_PATH;

if (!companyId) {
  console.error("Set TETHR_COMPANY_ID to the Wandr Growth company id.");
  process.exit(1);
}
if (!seedPath) {
  console.error("Usage: node scripts/tethr-seed-memory.mjs <corpus.md>  (or set TETHR_MEMORY_SEED_PATH)");
  process.exit(1);
}

let corpus;
try {
  corpus = fs.readFileSync(seedPath, "utf8");
} catch (e) {
  console.error(`Cannot read ${seedPath}: ${e.message}`);
  process.exit(1);
}

const res = await fetch(`${base}/api/tethr/${companyId}/seed-memory`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ corpus }),
});
const data = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`Seed failed (${res.status}): ${data.error ?? "unknown"}`);
  process.exit(1);
}
console.log(`Parsed ${data.parsed} item(s): ${data.created} created, ${data.existing} already present.`);
