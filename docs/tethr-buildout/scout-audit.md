# Scout audit — 2026-07-09

**Conclusion: `../scout` does not exist at the expected path on this machine, so no audit
could be performed. This is not a blocker.** Per the RUN-ALL fallback, it is recorded as
MANUAL step #1, and Phase 2's inbound Slack surface builds **fresh on the `notify.ts` /
new `slack.ts` seam** instead of porting the existing bot.

## What was checked

```
ls -ld ../scout        →  No such file or directory
```

The gap analysis (§7, resolved question 2) says the Scout bot "lives in a repo named
`scout` at the same level as the paperclip folder (`../scout`)" — i.e.
`/Users/markkaram/git/scout`. That directory is absent in this environment. It may be:

- on a different machine / not cloned here,
- under a different path or name,
- or private to Frank and never mounted here.

## Impact on the roadmap (Phase 2)

Phase 2's definition of done has two halves:

1. **Outbound** — real Slack sender in `server/src/tethr/notify.ts` behind `SLACK_BOT_TOKEN`,
   posting to `#scout` (`C0AE02FJR5Y`). **Unaffected** — this is built regardless of Scout.
2. **Inbound** — originally "port Scout's Slack event handling into `server/src/tethr/slack.ts`."
   With `../scout` absent we **build the inbound surface fresh** on the same seam: a Slack
   events (or Socket Mode) handler in a new additive `server/src/tethr/slack.ts` that maps
   link/photo posts + tag-to-kickoff to Tethr's routing entry point
   (`server/src/tethr/routing.ts`). This is the phase file's documented fallback, so Phase 2
   is **not blocked** by the missing repo — only slightly larger (write vs. copy).

## What to do if `../scout` turns up (re-run the audit)

If Mark later clones or points to the Scout repo, run this before Phase 2's inbound step so
we reuse working code instead of rewriting it. Delegate to a subagent (read-only, skip
`node_modules`) and capture into this file:

- **Language/framework** and entry point.
- **Slack connection mode** — Socket Mode (app-level token, no public URL) vs Events API
  (request URL, signing secret). This decides whether Phase 2 needs a public webhook.
- **Event handlers** — what it does on link posts, photo posts, mentions/tags.
- **Content-kickoff flow** — what "tag to kick off content" actually triggers today.
- **Secrets/env** it needs (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET`, …).
- **How it runs on the laptop** (launchd? node process? Cowork task?) so it can be paused
  and restarted safely once Tethr's inbound surface passes its checkpoint.

Command to hand a subagent when the repo exists:

```
Read ../scout read-only (skip node_modules). Report: language/framework + entry point;
Slack connection mode (socket vs events, which tokens); every event handler and what it
does; the tag-to-kickoff flow; required env/secrets; how it's launched on the laptop and
how to pause/restart it. Write findings into docs/tethr-buildout/scout-audit.md.
```

## Rollback note carried to Phase 2

Whatever Scout does today keeps running on the laptop until Tethr's inbound surface passes
its #scout checkpoint. Only then is the laptop Scout process paused — never deleted.
