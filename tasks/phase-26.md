# Phase 26: Jev decides, tethr learns

Status: plan, waiting for Mark's go. Nothing in it is built yet.

## What Mark asked for (2026-11-09)

- "Plan out a full plan on implementing Jev here."
- "Eventually we need more capacities like file organization and stuff where we can email or send
  stuff to tethr and it knows how to sort and file it or route it to the right place."
- "The system needs to also learn. I wouldn't be opposed to even having an almost self learning
  system where there's an agent that's fetching data online to LEARN then apply the logic in
  appropriate areas so the self learning truly gets better. Everything from distribution, sales,
  customer interactions, all of it."
- "Eventually tethr should be able to self market and run its own business. That will be the
  ultimate sales strategy, where I am marketing tethr to others based on what it's doing and
  recommending."

## Who does what

Each system keeps one job. Every part of this plan follows the table.

| Job | System | In this phase |
|---|---|---|
| Runs and records the work | Paperclip | agents, tasks, schedules, budgets, approvals: unchanged |
| Thinks and writes | Claude, on the subscription | every chat and agent turn: unchanged |
| Remembers | Hermes | notes, every conversation, skills; now also the rules tethr learns |
| Decides | Jev | yes/no, pick one from a list, score: where things go, what matters, what's worth your time |
| The product on top | tethr | the front door, the safety rules, goals, and the record of what it learned |

Jev never writes text and Claude is never spent on a decision Jev can make. A Jev decision on a
3-page document costs well under a tenth of a cent.

## What the wiring review found (this plan depends on it)

1. **Jev now works, through Vercel's AI Gateway.** The saved key is a Vercel AI Gateway key,
   which TypeSafe's own server rejects. tethr now spots it and goes through Vercel's
   TypeSafe-compatible endpoint, billed to Vercel. Checked with real requests at about $0.00002
   each.
2. **Slack and the terminal client talk to the old classic engine**, not the chat brain. tethr in
   Slack has no memory, recall, connectors, goals or team, and nothing said there is remembered.
   "Send stuff to tethr" has to land on the real tethr, so this is fixed first (26.1).
3. **Slack only accepts images.** A PDF or document sent to tethr in Slack is dropped today.

## Defaults I picked (change any of them when you approve)

1. **Filing starts as suggestions.** tethr shows where it would put something and you tap. A kind
   of decision becomes automatic only after it has proven itself and you say yes.
2. **Intake order:** the Drive Inbox folder, chat uploads and Slack files first. Email comes after
   those work, because it needs a mailbox decision.
3. **What Jev may see:** the text of business documents, after a check on your Mac. Anything that
   looks like someone's health information never leaves the Mac and comes to a person.
4. **Who can reach the full tethr from Slack:** only the people marked admin in tethr (you, by your
   Slack member ID). Everyone else keeps the limited tethr until each person can have their own
   access.
5. **The learner:** working name `@sage`. It studies three areas at first: distribution, sales and
   customer experience, from public sources only.

## 26.1 One brain behind every door

Slack and the terminal client reach the same tethr as the app.

- **Slack, from an admin:** a DM goes into the main chat, the same ongoing conversation as the
  app. A mention in a channel thread gets its own side chat named after the channel. The answer is
  posted back into the Slack thread. An action that needs approval says so in Slack with a link,
  and the existing "approve" reply still works.
- **Slack, from anyone else:** the classic engine, as today. The chat brain carries the admin's
  own connectors (Gmail, Drive, Stripe), and reading with them needs no approval, so nobody else
  may drive it.
- **Terminal client:** `POST /route` uses the chat runner when the chat engine is "Claude
  session".
- **Files in Slack:** every file type is accepted, downloaded from Slack's own hosts only, and
  saved like a chat attachment. A file with a message goes to the chat. A file with no message
  goes to the Inbox (26.3).
- These turns are indexed into Hermes like any chat turn, so recall covers Slack too.

Files: `slack.ts` (`routeInboundKickoff`, `extractImageFiles` becomes all files), `routes/tethr.ts`
(`POST /route`), `assistant/runner.ts`, `assistant/attachments.ts`, `assistant/turns.ts`
(`waitForTurn`).

## 26.2 The decision service

One place where tethr asks Jev, with a record of every answer and what happened next.

- **`server/src/tethr/decide/`:**
  - `kinds.ts`: each kind of decision (file destination, who should know, report urgency, lesson
    score) with its question, where its options come from, and its mode.
  - `decide.ts`: builds the request (the item, the options, the learned rules, a few past
    examples), calls `jevAsk`, returns the pick, the runner-up and the confidence.
  - The check that runs on the Mac before anything is sent (26.3) already exists:
    `server/src/tethr/screen.ts`, built in the wiring review for memory and the search index.
- **Modes per kind**, on Integrations, "Jev decisions": Off, Suggest, Automatic. Money, anything
  public and anything medical can never be Automatic.
- **The record:** table `tethr_decisions` (migration 0097): kind, a short label, the options,
  Jev's pick, confidence, cost, and the outcome (accepted, corrected to what, automatic, undone).
  It never stores the content that was judged.
- **Confidence that calibrates itself:** for each kind, tethr works out from the record the
  confidence above which you accepted at least 95% of the last 50 decisions. Below it, it asks.
- **Backtest before automatic:** before a kind can be switched to Automatic, tethr replays its
  past decisions with today's rules and shows the score ("would have got 46 of 50 right").
- **Demotion:** two corrections of automatic decisions in a week put that kind back to Suggest and
  tell you.
- **Spend cap:** a monthly Jev cap (default $5), summed from the record. Past it, or when Jev is
  down, items come to you without a suggestion.

Reuse: `jev.ts` (`jevAsk`, `jevHealth`), `compositeOf` and `uncertainOf` in
`assistant/tethr-tools.ts`.

## 26.3 The Inbox: send anything to tethr and it files or routes it

1. **It arrives.** `00 Tethr/00 Inbox/` in Drive (tethr makes the folder and looks once a minute;
   a file must be unchanged for 30 seconds), "File this" on a chat upload, or a Slack file (26.1).
2. **tethr reads it.** Text, Word, Excel and PowerPoint with the readers it has
   (`office-text.ts`). PDFs with a new text reader (first 5 pages). Images by name only at first.
3. **The check on the Mac** (`tethr/screen.ts`, extended with card numbers and keys). It flags
   text that ties a particular person to a health detail; ordinary travel-medicine wording
   passes. A match means "needs a person": nothing is sent to Jev and nothing is filed on its own.
4. **Jev decides,** in one request:
   - what it is (invoice, contract, partner material, research, report, other)
   - where it goes, chosen from your real folders
   - who should know: a person on the team, an agent, or nobody
   - how soon someone needs to act
5. **tethr acts.**
   - Suggest: a card in the chat and in the Drive's new Inbox view. Buttons: Jev's pick, two
     alternatives, "Somewhere else", "Leave it".
   - Automatic: it moves the file with `fsMove` and tells whoever needs to know. "Put it back"
     works for 7 days.
   - It never deletes. `99 Archive`, the root documents and tethr's own workspace are protected,
     as in `drive-changes.ts`.
   - Telling a person is a bell and a Slack DM with the file's name and where it went, never its
     content. Handing it to an agent is a task through `team.assign`, as a card unless that kind
     is Automatic.
6. **It learns.**
   - Every tap is an example. Each folder gets a profile (its name, a one-line description, a
     sample of what's in it) that updates from what you actually file there.
   - After two corrections of the same kind, tethr proposes a rule in plain words ("Invoices from
     Acme go to 05 Finance / Invoices"). On your yes it is saved in Hermes as part of the skill
     `filing-rules` and given to Jev with every filing decision.

Table `tethr_inbox_items` (migration 0098). Files: new `server/src/tethr/inbox/` (intake, read,
pipeline), `fsdrive.ts` (reuse `listFsChildren`, `fsMove`), `routes/tethr-inbox.ts`,
`ui/src/pages/tethr/drive/Finder.tsx` (Inbox location and badge), a chat card.

## 26.4 Jev at tethr's other decision points

- **Agent reports** (`team-report.ts deliverAgentReport`): does this need you now, or can it wait
  for the daily review? Now means a Slack DM; wait means it is held for the review.
- **Idea slots** (`watch.ts`): tethr offers only a few ideas a week. Jev would rank the candidate
  conversations so the slots go to the best ones. Off by default: it sends Slack text to TypeSafe,
  so it needs its own yes from you.
- **Lessons** (26.6): scoring what the learner brings back.
- **Lists:** `score_list` as today, plus scoring templates for leads and partners saved as skills.
- Anything that needs words (a reply, a brief, a plan) stays with Claude.

## 26.5 Learning: three loops, one record

tethr learns from you, from results and from the world. Everything it learns is one record you
can read, with where it's applied and what happened.

- **The record:** table `tethr_lessons` (migration 0099): area, the lesson in one sentence, how to
  apply it, sources, scores, status (candidate, proposed, applied, kept, retired, rejected), what
  it was applied as, the goal it should move, when to review it, and the outcome.
- **Loop 1, from you.** The decision record (26.2): your taps and corrections become filing
  rules and calibrated confidence. A correction in chat ("no, we never discount") is saved as a
  memory entry or a rule, with your OK.
- **Loop 2, from results.** Every applied lesson and every experiment is tied to a goal and has a
  review date. The Friday scorecard gets a section, "What we tried": tethr reads the number,
  says whether the lesson held, and proposes keeping or retiring it. A retired lesson is removed
  from memory, skills or rules, and the record keeps why.
- **Loop 3, from the world.** The learner (26.6).
- **Where lessons live:** a principle becomes a memory entry in Hermes, a procedure becomes a
  skill, a decision rule goes to Jev, a tactic for an agent becomes a change to its instructions
  (a card), and an experiment becomes a task with a goal and a date.
- **Learning page:** what tethr learned by area, where each lesson is applied, what the number
  did, how accurate each kind of decision is, the rules, and the switches.

Files: new `server/src/tethr/learn/` (lessons service, apply, review), `rhythm.ts` (the scorecard
playbook), `hermes/memory-layer.ts` (`changeMemory`, `saveSkill`), `ui/src/pages/tethr/
TethrLearning.tsx`.

## 26.6 The learner: an agent that studies and brings back lessons

- **What it is:** a ready-made agent on tethr's team (the phase 23 framework), working name
  `@sage`. It exists only once you switch it on in Integrations, "Learning". It has a budget cap
  and a daily run cap like every agent.
- **What it studies:** one area per run, on a weekly rotation: distribution, sales, customer
  experience. Its brief is built for each run from your goals (areas behind pace get more
  attention), what tethr already knows (so it doesn't repeat itself), which sources have earned
  trust, and topics you or tethr queued ("study how telehealth companies do referral programs").
- **It works in a sealed room.** Its own folder with its own instructions: the company in one
  line and the goal titles. No memory, no notes about people, no connectors, no team tools. Web
  search and public pages only. A hostile page has nothing to steal and nothing to misuse.
- **How lessons come back:** one tool, `propose_lesson`: the area, the lesson (300 characters at
  most), why it matters, how to apply it, up to 3 sources, and the kind of evidence (data, case
  study, expert opinion, vendor claim). Then, on the server:
  1. A scan for instructions hidden in the text.
  2. Anything that makes a medical claim is dropped: that is a licensed person's call.
  3. Repeats of what tethr already knows are dropped.
  4. Jev scores it: fits this business, strength of evidence, usable this month, new.
- **What you see:** the best few a week as cards in the main chat: the lesson, its source, how it
  would be applied, and Apply, Not for us, Reply. The rest wait on the Learning page. The number
  of cards follows the ideas pace you already set.
- **How it gets better:**
  - Sources earn a track record: lessons approved against rejected, kept against retired. That
    record goes into its next brief and into Jev's evidence question.
  - "Not for us" with a reason becomes a rule ("we don't cold call").
  - Areas whose lessons keep getting rejected slow down. Areas tied to goals behind pace speed up.
- **Customer interactions:** from public sources and your own totals at first. Learning from your
  own customer messages means patient information, so it is a separate decision and not in this
  phase.
- Lessons are paraphrased with a link to the source, never long quotes.

Files: `team.ts` and `team-spec.ts` (a built-in template and a `sandbox` flag),
`assistant/runner.ts` and `assistant/workspace.ts` (the sealed folder),
`assistant/learn-tools.ts` (`propose_lesson`, `study`), `learn/` (26.5).

## 26.7 Email, after the Inbox has proven itself

- A Gmail label or a dedicated address (your call) that a scheduled chat turn reads through the
  Gmail connector, at most once an hour. Attachments and forwarded mail go into the Inbox
  pipeline.
- Each check is one Claude turn on the subscription. Sending or replying still needs approval.

## 26.8 Later: tethr markets itself

Not built in this phase. What this phase leaves ready for it:

- The lessons record with outcomes is the evidence of what works.
- The decision record gives accuracy numbers you can show.
- Agents are tied to goals, and a learner already studies distribution and sales.

The steps after that: tethr as its own company inside tethr (its own goals for sign-ups and
revenue, its own agents for content, outreach and follow-up), a public proof page built from
outcomes with names removed (anything public always asks), hosted logins, and learning kept
separate per customer so one company's data never feeds another's lessons.

## Rules that hold throughout

- **Nothing runs on its own until you switch it on.** Every piece ships Off. Builds never create,
  propose or run anything on your tethr; checks happen on a throwaway copy.
- **Never patient information.** The check on the Mac runs before Jev sees anything. The learner
  has no access to company data. Memory and lessons refuse health details.
- **Money, public and medical always ask.** No mode changes that.
- **Subscription only.** Claude turns stay on Claude Code. Hermes still never calls a model. Jev
  is the one metered service, with a monthly cap.
- **Everything learned is visible and reversible.** Each rule, lesson and automatic move has a
  source, a date and an undo.
- **Web text is data.** What the learner reads can only come back as a short, scanned, scored
  lesson that you approve.

## Order of work

| Step | Delivers | Needs from you |
|---|---|---|
| 26.1 | Slack and the terminal reach the real tethr; Slack accepts files | nothing |
| 26.2 | Jev decisions with a record, modes and a cap | nothing (the key works) |
| 26.3 | The Inbox, with suggestions | first test: drop files in the Inbox folder |
| 26.4 | Report urgency, lesson scoring | nothing |
| 26.5 | The lessons record, the Friday review, the Learning page | nothing |
| 26.6 | The learner | switch it on when you want it |
| 26.7 | Email intake | pick a label or an address |

Each step ends with its tests, a check on a throwaway copy and a local commit. Nothing is pushed.

## Tests and checks

- **Unit:** the decision service against a fake Jev (modes, confidence, the cap, demotion, the
  backtest), the check on the Mac, folder profiles, rule proposals, lesson scoring and dedupe,
  the sealed folder's instructions.
- **With the database:** an Inbox item from arrival to a card to a move to "Put it back"; a
  correction becoming a rule; a lesson from `propose_lesson` to a card to a memory entry to a
  Friday review; Slack from an admin reaching the chat runner and Slack from anyone else not.
- **Never allowed, each with a test:** content in the decision record, a file leaving the 00 Tethr
  folder, a delete, a flagged file reaching Jev, the learner seeing memory, a non-admin driving
  the chat brain.
- **Throwaway copy, real Claude, real Jev:** a temporary Hermes root and a working Jev key copied
  into the throwaway's own settings (never printed, deleted after). Drop five files, correct two,
  see the rule; run the learner once on one area; Slack through a test channel only with your OK.
