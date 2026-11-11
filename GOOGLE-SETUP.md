# Google Ads · Keyword Planner · Google Drive — Tethr setup

Recycles the Scout app's integrations into Tethr's agents, and writes deliverables to a Google
Drive folder you control. Local now, cloud-ready (same creds work on Railway).

## What's wired

| Capability | Tool | Agents allowed | Notes |
|---|---|---|---|
| **Google Ads** (overview / campaigns / keywords / search terms) | `google_ads_report` (`tools/google-ads.ts`) | **Tailwind** (analyze/bids/negatives), **Ledger** (reporter/modeler/guardrails) | **READ-ONLY.** Agents analyze + recommend; they can't change the account or spend. |
| **Google search volume** (Keyword Planner) | `keyword_ideas` (`tools/keyword-planner.ts`) | **Atlas** (blog/keywords), **Beacon** (icp/messaging) | Real volume/competition/CPC to pick topics + avoid zero-volume ideas. |
| **PostHog** | `posthog` (Phase 8) | **Pulse** (+ Ledger) | Read-only analytics — already built. |
| **→ Google Drive** | `tools/google-drive.ts` + publish hook | all | Every published deliverable is mirrored into your Tethr Drive folder. |

## The safety line (important)

Google Ads moves real money, so **no autonomous agent can mutate the account.** Only the
read/analyze queries are ported — none of Scout's mutate functions (bid/budget/campaign/ad
changes) exist in Tethr. An agent that wants a change produces a **`spend`-gated recommendation**
you approve in the Queue (or apply yourself in Scout's UI). This is enforced by the allowlist +
`gating.ts` and locked by `tethr-google.test.ts` (asserts no mutating ads tool exists and that
the tool is never granted to the scout agent).

## Google Ads + Keyword Planner — already configured

The `GOOGLE_ADS_*` OAuth creds were copied from Scout into your local Tethr instance env
(`~/.paperclip/instances/default/.env`). Nothing else to do for the ads reports.

**Keyword Planner caveat:** search-volume needs a **Basic or Standard** Google Ads developer
token. If yours is an Explorer/test token, `keyword_ideas` returns a clear
`DEVELOPER_TOKEN_NOT_APPROVED` message — request Basic access in the Google Ads API Center. The
ads *reports* (`google_ads_report`) work on any token level.

## Google Drive — v1 ships WITHOUT any of this (desktop-sync mirror, 2026-07-13)

The service-account setup below hit org-policy permission blocks, so the live v1 path needs
**no Google credentials at all**: `TETHR_MIRROR_DIR` points at the Drive-for-desktop-synced
`00 Tethr` folder and `server/src/tethr/mirror.ts` writes published deliverables there as
plain files; the desktop client uploads them. See CLAUDE.md → "D2 — shared Google Drive
workspace". The section below remains the **v2 (cloud)** path for when the server no longer
runs on a machine with Drive for desktop.

## Google Drive v2 (cloud) — the one new credential (service account, tightly scoped)

A **service account can only touch files/folders you explicitly share with it** — so sharing
just the "Tethr" folder means it can write there and *nowhere else* in your Drive. Same key works
on Railway later.

1. **Create the service account** — Google Cloud Console → your existing project (the one behind
   the Google Ads OAuth) → **IAM & Admin → Service Accounts → Create**. Name it e.g. `tethr-drive`.
   No project roles needed.
2. **Make a key** — that service account → **Keys → Add key → JSON** → download it. Save it
   somewhere the Tethr server can read (e.g. `~/.paperclip/tethr-drive-sa.json`). **Never commit it.**
3. **Enable the Drive API** — in the same project, **APIs & Services → Enable APIs → Google Drive API**.
4. **Share the Tethr folder with the service account** — in Google Drive, open your Tethr folder →
   Share → paste the service account's email (`…@….iam.gserviceaccount.com`, in the JSON as
   `client_email`) → **Editor**. That folder (and only it) is now writable.
5. **Point Tethr at it** — in `~/.paperclip/instances/default/.env`:
   ```
   TETHR_GDRIVE_SA_KEY_PATH=/Users/markkaram/.paperclip/tethr-drive-sa.json
   TETHR_GDRIVE_FOLDER_ID=<the folder id from the Drive URL: .../folders/THIS_PART>
   ```
   (Cloud: put the JSON inline in `TETHR_GDRIVE_SA_KEY` as a Railway variable instead of a path.)

Restart `pnpm dev`. From then on, whenever an agent's output publishes (after its approval gate),
a markdown copy lands in that Drive folder. The write is best-effort — if Drive is down or
misconfigured, the output still lives in Tethr's in-app Drive and #scout; publishing never fails.

## Verify

- Ask Ledger/Tailwind (Console or Slack): "how are our Google Ads doing this month?" → it calls
  `google_ads_report` and summarizes real numbers.
- Ask Atlas/Beacon: "what's the search volume for peru travel vaccines?" → `keyword_ideas`.
- Approve any gated output in the Queue → a `.md` file appears in your Tethr Drive folder.

## Cloud (later)

All three work unchanged on Railway: set the same `GOOGLE_ADS_*`, `POSTHOG_API_KEY`, and the
Drive service-account JSON (`TETHR_GDRIVE_SA_KEY`) + `TETHR_GDRIVE_FOLDER_ID` as Railway
variables. The service-account scoping means the cloud server, too, can only touch the one shared
folder.
