import { Router, type Request, type Response } from "express";
import { desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tethrIdeas } from "@paperclipai/db";
import { logActivity } from "../services/activity-log.js";
import { getAssistantRunner } from "../tethr/assistant/runner.js";
import { logFailure } from "../tethr/best-effort.js";
import * as chats from "../tethr/chats.js";
import { adminFirstName, CompanyInputError, companyProfileService } from "../tethr/company.js";
import { GROWTH_PACES, PACE_LABEL, PACE_UPLIFT, type GrowthPace } from "../tethr/goal-pace.js";
import { GoalInputError, goalsService } from "../tethr/goals.js";
import { getIntegrations, modeFor, sanitizeIntegrationsPatch, updateIntegrations } from "../tethr/integrations.js";
import { jevHealth, jevHealthText, type JevHealth } from "../tethr/jev.js";
import { foldInterviewIntoMainChat } from "../tethr/main-chat.js";
import { mirrorDir } from "../tethr/mirror.js";
import { TETHR_MISSION } from "../tethr/mission.js";
import { getRoster } from "../tethr/overseers.js";
import { describeAllowance, getPace, IDEAS_LEVELS, IDEAS_LEVELS_ORDER, type IdeasLevel } from "../tethr/pace.js";
import { POSITIONS } from "../tethr/positions.js";
import { applyRhythm, operationsThreadId, RHYTHMS, runRhythmNow } from "../tethr/rhythm.js";
import {
  getSetup,
  interviewBrief,
  RHYTHM_KEYS,
  type RhythmKey,
  SETUP_STEPS,
  type SetupStep,
  updateSetup,
  validCron,
  validTimezone,
} from "../tethr/setup.js";
import { slackConfigured } from "../tethr/slack.js";
import { googleAdsConfigured } from "../tethr/tools/google-ads.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { requirePerson } from "./tethr-people.js";

// Goals with numbers, tethr's setup (onboarding) and the ideas it offers on its
// own (phases 20-21). Mounted by tethrRoutes (routes/tethr.ts). People only for
// anything that changes something; agents get 403.

export function tethrSetupRoutes(db: Db): Router {
  const router = Router();

  // ---- Goals with numbers (phase 20) ------------------------------------------
  const goalRoute =
    (fn: (req: Request, res: Response, companyId: string) => Promise<void>) => async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      if (!requirePerson(req, res)) return;
      try {
        await fn(req, res, companyId);
      } catch (err) {
        if (err instanceof GoalInputError || err instanceof CompanyInputError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
    };

  router.get("/tethr/:companyId/goals", goalRoute(async (_req, res, companyId) => {
    res.json(await goalsService(db).list(companyId));
  }));
  router.post("/tethr/:companyId/goals", goalRoute(async (req, res, companyId) => {
    res.json(await goalsService(db).saveGoal(companyId, (req.body ?? {}) as Record<string, unknown>));
  }));
  router.post("/tethr/:companyId/goals/metrics", goalRoute(async (req, res, companyId) => {
    res.json(await goalsService(db).saveMetric(companyId, (req.body ?? {}) as Record<string, unknown>));
  }));
  router.post("/tethr/:companyId/goals/metrics/:metricId/measurements", goalRoute(async (req, res, companyId) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { recordMeasurementAndReviewTarget } = await import("../tethr/goal-pace.js");
    res.json(await recordMeasurementAndReviewTarget(db, companyId, req.params.metricId as string, { value: body.value, at: body.at, note: body.note }));
  }));
  router.delete("/tethr/:companyId/goals/metrics/:metricId", goalRoute(async (req, res, companyId) => {
    await goalsService(db).deleteMetric(companyId, req.params.metricId as string);
    res.json({ ok: true });
  }));

  // ---- Setup / onboarding (phase 20) -------------------------------------------
  const setupChecks = (companyId: string, adminSlackId: string | null, jev: JevHealth) => {
    const cfg = getIntegrations(companyId);
    const mode = (label: string) => modeFor(cfg, label);
    const growth = getRoster(companyId).growth;
    const approverId = adminSlackId ?? growth?.slackId ?? null;
    const listening = slackConfigured() && !!process.env.SLACK_APP_TOKEN?.trim();
    return [
      { key: "stripe", label: "Stripe (revenue and new customers)", ok: mode("Stripe") !== "off", detail: `Mode: ${mode("Stripe")}`, href: "/tethr-settings" },
      { key: "posthog", label: "PostHog (traffic and conversion)", ok: mode("PostHog") !== "off", detail: `Mode: ${mode("PostHog")}`, href: "/tethr-settings" },
      { key: "google_ads", label: "Google Ads (spend and keyword volumes)", ok: googleAdsConfigured(), detail: googleAdsConfigured() ? "Connected" : "Add the GOOGLE_ADS_* settings", href: "/environment" },
      { key: "gmail", label: "Gmail", ok: mode("Gmail") !== "off", detail: `Mode: ${mode("Gmail")}`, href: "/tethr-settings" },
      { key: "slack_connector", label: "Slack (reading)", ok: mode("Slack") !== "off", detail: `Mode: ${mode("Slack")}`, href: "/tethr-settings" },
      { key: "slack_bot", label: "Slack bot for #tethr posts and approvals", ok: slackConfigured(), detail: slackConfigured() ? "Token set" : "Add SLACK_BOT_TOKEN", href: "/environment" },
      { key: "approver", label: "Your Slack member ID (approve from Slack, ideas by DM)", ok: !!approverId, detail: approverId ? "Set" : "Add it in step 1", href: "/setup" },
      {
        key: "slack_listen",
        label: "tethr hears Slack conversations",
        ok: listening,
        detail: listening
          ? "Invite @tethr to the channels it should hear. Private channels and group DMs need two more Slack permissions (see MANUAL-STEPS)."
          : "Needs the Slack bot and app tokens",
        href: "/environment",
        optional: true,
      },
      // "ok" only when TypeSafe accepts the key (a saved key can still be rejected).
      { key: "jev", label: "Jev (fast decisions and list scoring)", ok: jev === "ok", detail: jevHealthText(jev), href: "/environment", optional: true },
      { key: "drive", label: "Google Drive folder (00 Tethr)", ok: !!mirrorDir(), detail: mirrorDir() ?? "Not found", href: "/drive" },
    ];
  };

  router.get("/tethr/:companyId/setup", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const state = getSetup(companyId);
    const profile = await companyProfileService(db).get(companyId);
    const pace = getPace(companyId, state.ideas);
    res.json({
      state,
      checks: setupChecks(companyId, profile?.admin?.slackUserId ?? null, await jevHealth()),
      goals: await goalsService(db).list(companyId),
      rhythms: RHYTHMS,
      profile,
      mission: TETHR_MISSION,
      positions: POSITIONS,
      growthPaces: GROWTH_PACES.map((key) => ({ key, label: PACE_LABEL[key], uplift: PACE_UPLIFT[key] })),
      ideasLevels: IDEAS_LEVELS_ORDER.map((key) => ({ key, label: IDEAS_LEVELS[key].label, blurb: IDEAS_LEVELS[key].blurb })),
      ideasPace: { allowance: pace.allowance, now: describeAllowance(pace.allowance), recent: pace.recent.slice(-10) },
    });
  });

  // Step 1 (phase 21): the company and you, its admin. The mission is built
  // in; the root goal follows the company's name.
  router.put("/tethr/:companyId/setup/company", goalRoute(async (req, res, companyId) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const profile = await companyProfileService(db).saveCompanyStep(companyId, body);
    const timezone = validTimezone(body.timezone) ? body.timezone : getSetup(companyId).timezone;
    if (Array.isArray(body.internalAddresses)) {
      const patch = sanitizeIntegrationsPatch({ internalAddresses: body.internalAddresses });
      await updateIntegrations(companyId, { internalAddresses: patch.internalAddresses ?? [] });
    }
    const state = await updateSetup(companyId, (s) => ({ ...s, timezone, steps: { ...s.steps, company: new Date().toISOString() } }));
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: getActorInfo(req).actorId,
      action: "tethr_company_profile_saved",
      entityType: "company",
      entityId: companyId,
      details: { name: profile.name, position: profile.admin?.position ?? null },
    }).catch(logFailure("activity log"));
    res.json({ state, profile });
  }));

  // Step 2: what to work on first, and how hard the goals push.
  router.put("/tethr/:companyId/setup/focus", goalRoute(async (req, res, companyId) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const areas = (Array.isArray(body.areas) ? body.areas : [])
      .map((a) => String(a ?? "").replace(/\s+/g, " ").trim().slice(0, 80))
      .filter(Boolean)
      .slice(0, 6);
    if (!areas.length) {
      res.status(400).json({ error: "Pick at least one goal area." });
      return;
    }
    const growthPace = GROWTH_PACES.includes(body.growthPace as GrowthPace) ? (body.growthPace as GrowthPace) : getSetup(companyId).growthPace;
    const autoAdjust = typeof body.autoAdjust === "boolean" ? body.autoAdjust : getSetup(companyId).autoAdjust;
    const goals = await goalsService(db).syncAreas(companyId, areas);
    const state = await updateSetup(companyId, (s) => ({ ...s, areas, growthPace, autoAdjust, steps: { ...s.steps, focus: new Date().toISOString() } }));
    res.json({ state, goals });
  }));

  router.post("/tethr/:companyId/setup/steps/:step", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!requirePerson(req, res)) return;
    const step = req.params.step as SetupStep;
    if (!SETUP_STEPS.includes(step)) {
      res.status(400).json({ error: "Unknown step" });
      return;
    }
    const done = req.body?.done !== false;
    res.json(
      await updateSetup(companyId, (s) => {
        const steps = { ...s.steps };
        if (done) steps[step] = new Date().toISOString();
        else delete steps[step];
        return { ...s, steps };
      }),
    );
  });

  router.post("/tethr/:companyId/setup/interview", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!requirePerson(req, res)) return;
    // The interview runs in the main chat, the one ongoing conversation (an
    // older side-chat interview is folded into it while the main chat is empty).
    await foldInterviewIntoMainChat(db, companyId);
    const state = getSetup(companyId);
    if (state.interviewThreadId && req.body?.restart !== true) {
      res.json({ threadId: state.interviewThreadId, started: false });
      return;
    }
    const actor = getActorInfo(req);
    const profile = await companyProfileService(db).get(companyId);
    const ids = await getAssistantRunner(db).send({
      companyId,
      threadId: chats.mainThreadId(companyId),
      text: interviewBrief(state.areas, { person: adminFirstName(profile), company: profile?.name ?? null, pace: state.growthPace }),
      kind: "system",
      requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
    });
    await updateSetup(companyId, (s) => ({ ...s, interviewThreadId: ids.threadId }));
    res.json({ threadId: ids.threadId, started: true });
  });

  router.put("/tethr/:companyId/setup/rhythm", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!requirePerson(req, res)) return;
    const body = (req.body ?? {}) as { timezone?: unknown; rhythm?: Record<string, Record<string, unknown>>; ideas?: Record<string, unknown> };
    const current = getSetup(companyId);
    const timezone = body.timezone === undefined ? current.timezone : body.timezone;
    if (!validTimezone(timezone)) {
      res.status(400).json({ error: "That time zone isn't recognized." });
      return;
    }
    const rhythm = { ...current.rhythm };
    for (const key of RHYTHM_KEYS) {
      const raw = body.rhythm?.[key];
      if (!raw) continue;
      const cron = raw.cron === undefined ? rhythm[key].cron : raw.cron;
      if (!validCron(cron)) {
        res.status(400).json({ error: `${RHYTHMS[key].label}: that schedule isn't valid.` });
        return;
      }
      rhythm[key] = { ...rhythm[key], enabled: raw.enabled === true, slack: raw.slack === true, cron };
    }
    const ideas = { ...current.ideas };
    if (body.ideas && typeof body.ideas === "object") {
      if (IDEAS_LEVELS_ORDER.includes(body.ideas.level as IdeasLevel)) ideas.level = body.ideas.level as IdeasLevel;
      if (typeof body.ideas.adaptive === "boolean") ideas.adaptive = body.ideas.adaptive;
      if (typeof body.ideas.slackListen === "boolean") ideas.slackListen = body.ideas.slackListen;
    }
    const actor = getActorInfo(req);
    const applied = await applyRhythm(db, companyId, rhythm, timezone, { userId: actor.actorId });
    res.json(await updateSetup(companyId, (s) => ({ ...s, timezone, rhythm: applied, ideas, steps: { ...s.steps, rhythm: new Date().toISOString() } })));
  });

  router.post("/tethr/:companyId/setup/rhythm/:key/run", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!requirePerson(req, res)) return;
    const key = req.params.key as RhythmKey;
    if (!RHYTHM_KEYS.includes(key)) {
      res.status(400).json({ error: "Unknown rhythm item" });
      return;
    }
    const actor = getActorInfo(req);
    res.json({ ...(await runRhythmNow(db, companyId, key, { userId: actor.actorId })), threadId: operationsThreadId(companyId) });
  });

  router.post("/tethr/:companyId/setup/complete", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!requirePerson(req, res)) return;
    const done = req.body?.done !== false;
    res.json(await updateSetup(companyId, (s) => ({ ...s, completedAt: done ? new Date().toISOString() : null })));
  });

  // ---- Ideas tethr offered on its own (phase 21) ----------------------------------
  router.get("/tethr/:companyId/ideas", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { tethrIdeas } = await import("@paperclipai/db");
    const rows = await db.select().from(tethrIdeas).where(eq(tethrIdeas.companyId, companyId)).orderBy(desc(tethrIdeas.createdAt)).limit(50);
    res.json(rows);
  });

  router.post("/tethr/:companyId/ideas/:ideaId/feedback", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!requirePerson(req, res)) return;
    const verdict = req.body?.verdict;
    if (verdict !== "useful" && verdict !== "not_now") {
      res.status(400).json({ error: "verdict must be useful or not_now" });
      return;
    }
    const { resolveIdea } = await import("../tethr/watch.js");
    const idea = await resolveIdea(db, companyId, req.params.ideaId as string, verdict);
    if (!idea) {
      res.status(404).json({ error: "No such idea" });
      return;
    }
    res.json(idea);
  });

  return router;
}
