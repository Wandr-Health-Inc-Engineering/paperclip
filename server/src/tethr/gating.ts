import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, tethrAgentProfiles, tethrOutputs, tethrSubagents } from "@paperclipai/db";
import {
  TETHR_GATED_SENSITIVITIES,
  TETHR_OUTPUT_APPROVAL_TYPE,
  type TethrAgentSpec,
  type TethrOutputKind,
  type TethrSensitivity,
} from "@paperclipai/shared";
import { logActivity } from "../services/activity-log.js";
import { logger } from "../middleware/logger.js";
import { driveService } from "./drive.js";
import { instantiateAgentFromSpec } from "./factory.js";
import { notificationService } from "./notify.js";
import { trackerService, type TrackerName } from "./state.js";

// The compliance layer. Anything medical / public-facing / spend / PR is
// created as a *gated* output with a linked core approval. The ONLY way an
// output reaches `published` is through decide("approve") below — approving,
// rejecting, or requesting changes is recorded with reviewer + reason in the
// core activity log. There is no advisory path: publish checks the approval
// row itself, so a gated output without an approved approval cannot ship.

const PUBLISH_FOLDERS: Partial<Record<TethrOutputKind, string>> = {
  lead_digest: "/scout/leads",
  reply_draft: "/scout/replies",
  news_digest: "/scout/news",
  blog_draft: "/content/blog",
  brief: "/briefs",
  itinerary: "/itineraries",
  press_release: "/newsroom",
  ads_recommendation: "/ads/recommendations",
  analytics_report: "/analytics",
  icp_profile: "/strategy",
  messaging: "/strategy",
  document: "/documents",
  // Coordinator chat answers get their own area, kept out of the deliverables tree.
  answer: "/tethr/chat-log",
};

export interface CreateOutputInput {
  companyId: string;
  agentId: string;
  agentTag: string;
  subagentId?: string | null;
  routeRunId?: string | null;
  heartbeatRunId?: string | null;
  kind: TethrOutputKind;
  title: string;
  body: string;
  sensitivity: TethrSensitivity;
  meta?: Record<string, unknown>;
  revisionOfId?: string | null;
  revisionNumber?: number;
}

export function isGatedSensitivity(sensitivity: TethrSensitivity): boolean {
  return (TETHR_GATED_SENSITIVITIES as readonly string[]).includes(sensitivity);
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "output"
  );
}

export function gatingService(db: Db) {
  const drive = driveService(db);
  const notify = notificationService(db);

  async function createOutput(input: CreateOutputInput) {
    const gated = isGatedSensitivity(input.sensitivity);

    const [output] = await db
      .insert(tethrOutputs)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        subagentId: input.subagentId ?? null,
        routeRunId: input.routeRunId ?? null,
        heartbeatRunId: input.heartbeatRunId ?? null,
        kind: input.kind,
        title: input.title,
        body: input.body,
        sensitivity: input.sensitivity,
        status: gated ? "gated" : "draft",
        meta: { ...(input.meta ?? {}), agentTag: input.agentTag },
        revisionOfId: input.revisionOfId ?? null,
        revisionNumber: input.revisionNumber ?? 1,
      })
      .returning();

    if (gated) {
      const [approval] = await db
        .insert(approvals)
        .values({
          companyId: input.companyId,
          type: TETHR_OUTPUT_APPROVAL_TYPE,
          requestedByAgentId: input.agentId,
          status: "pending",
          payload: {
            outputId: output.id,
            kind: input.kind,
            title: input.title,
            sensitivity: input.sensitivity,
            agentTag: input.agentTag,
            preview: input.body.slice(0, 600),
          },
        })
        .returning();

      await db
        .update(tethrOutputs)
        .set({ approvalId: approval.id, updatedAt: new Date() })
        .where(eq(tethrOutputs.id, output.id));
      output.approvalId = approval.id;

      await notify.send({
        companyId: input.companyId,
        kind: "approval",
        title: `${input.agentTag} staged ${labelForSensitivity(input.sensitivity)} output for review`,
        body: input.title,
        href: `/queue/${output.id}`,
        agentTag: input.agentTag,
      });
    } else {
      // Non-gated work products surface immediately as published deliverables.
      await publishToDrive(output.id, input.companyId, "auto");
    }

    await logActivity(db, {
      companyId: input.companyId,
      actorType: "agent",
      actorId: input.agentTag,
      action: gated ? "tethr_output_gated" : "tethr_output_created",
      entityType: "tethr_output",
      entityId: output.id,
      agentId: input.agentId,
      details: {
        kind: input.kind,
        title: input.title,
        sensitivity: input.sensitivity,
        gated,
      },
    });

    // Auto-approve: if the producing agent is on "auto", apply its role-
    // appropriate org decision without a human click. STRUCTURALLY limited to
    // sensitivity "org" (agent_proposal / org_change) — spend, medical, public,
    // and pr can never reach here — and budget-change org_changes are carved out
    // (always manual, Mark's rule). Auto-created agents still seed paused.
    let autoApproved = false;
    if (gated && input.sensitivity === "org") {
      const change = (input.meta?.change ?? null) as { op?: string } | null;
      const isBudgetChange = input.kind === "org_change" && change?.op === "update_budget";
      if (!isBudgetChange) {
        const [profile] = await db
          .select({ autoApprove: tethrAgentProfiles.autoApprove })
          .from(tethrAgentProfiles)
          .where(eq(tethrAgentProfiles.agentId, input.agentId))
          .limit(1);
        if (profile?.autoApprove) {
          await decide({
            companyId: input.companyId,
            outputId: output.id,
            decision: "approve",
            reviewer: `auto:${input.agentTag}`,
          });
          autoApproved = true;
        }
      }
    }

    // Buzz the responsible agent's overseer on Slack (heartbeat FYIs + things
    // that still need a human). Best-effort; dynamic import dodges a cycle.
    try {
      const { dmOverseer } = await import("./slack.js");
      // A card asked from a Slack conversation (phase 26.1) is asked there instead.
      const askedInSlack = Boolean((input.meta as Record<string, unknown> | undefined)?.slack);
      if (gated && !autoApproved && !askedInSlack) {
        await dmOverseer(
          db,
          input.companyId,
          input.agentTag,
          approvalDmText(input.agentTag, input.title, output.id),
        );
      } else if (input.heartbeatRunId) {
        await dmOverseer(
          db,
          input.companyId,
          input.agentTag,
          `${input.agentTag} filed: *${input.title}* — open it in the Drive (00 Tethr).`,
        );
      }
    } catch (err) {
      logger.warn({ err }, "[tethr] overseer buzz failed");
    }

    return getOutput(input.companyId, output.id);
  }

  async function getOutput(companyId: string, outputId: string) {
    const [output] = await db
      .select()
      .from(tethrOutputs)
      .where(
        and(eq(tethrOutputs.companyId, companyId), eq(tethrOutputs.id, outputId)),
      )
      .limit(1);
    return output ?? null;
  }

  /**
   * The hard block. Publishing requires either a non-gated sensitivity or a
   * linked approval in `approved` state — verified against the approvals row,
   * not the output's own status.
   */
  async function assertPublishable(companyId: string, outputId: string) {
    const output = await getOutput(companyId, outputId);
    if (!output) throw new Error("Output not found");
    if (!isGatedSensitivity(output.sensitivity as TethrSensitivity)) return output;
    if (!output.approvalId) {
      throw new Error("Gated output has no approval — publish blocked");
    }
    const [approval] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, output.approvalId))
      .limit(1);
    if (!approval || approval.status !== "approved") {
      throw new Error(
        `Gated output cannot publish: approval status is ${approval?.status ?? "missing"}`,
      );
    }
    return output;
  }

  async function publishToDrive(
    outputId: string,
    companyId: string,
    publishedBy: string,
  ) {
    const output = await assertPublishable(companyId, outputId);
    const folder = PUBLISH_FOLDERS[output.kind as TethrOutputKind] ?? "/documents";
    const path = `${folder}/${slugify(output.title)}.md`;
    const { node } = await drive.putFile({
      companyId,
      path,
      content: `# ${output.title}\n\n${output.body}\n`,
      tags: [output.kind, output.sensitivity, "published"],
      createdByTag: (output.meta as Record<string, unknown>)?.agentTag as string ?? "tethr",
      note: `Published from output ${output.id}`,
      permissions: { owner: "mark", read: ["*"], write: ["mark"] },
    });
    const [updated] = await db
      .update(tethrOutputs)
      .set({
        status: "published",
        driveNodeId: node.id,
        publishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(tethrOutputs.id, output.id))
      .returning();

    await logActivity(db, {
      companyId,
      actorType: publishedBy === "auto" ? "system" : "user",
      actorId: publishedBy,
      action: "tethr_output_published",
      entityType: "tethr_output",
      entityId: output.id,
      agentId: output.agentId,
      details: { title: output.title, drivePath: path, kind: output.kind },
    });

    // Shared-workspace mirror (phase 12, v1): project the published deliverable
    // as a plain file into the local Google Drive-synced folder ("00 Tethr").
    // Best-effort — a publish never fails because the mirror failed. Sits
    // before the answer early-return so enabling answers later is just a map
    // entry in MIRROR_FOLDERS (today "answer" is unmapped → no-op).
    try {
      const mirror = await import("./mirror.js");
      const outMeta = (output.meta ?? {}) as Record<string, unknown>;
      await mirror.mirrorPublishedOutput(db, {
        outputId: output.id,
        kind: output.kind as TethrOutputKind,
        title: output.title,
        body: output.body,
        agentTag: (outMeta.agentTag as string | undefined) ?? null,
        publishedAt: updated?.publishedAt ?? new Date(),
        folder: (outMeta.mirrorFolder as string | undefined) ?? null,
        format: (outMeta.mirrorFormat as string | undefined) ?? null,
      });
    } catch (err) {
      logger.warn({ err }, "[tethr] shared-folder mirror failed (publish unaffected)");
    }

    // Chat answers are conversational, not published content: they go to the
    // chat-log area (above) but never enter the dedup log, advance a tracker,
    // or mirror to Google Drive. Everything below is publish-of-record work.
    if (output.kind === "answer") {
      return updated;
    }

    // Working state: published content lands in the dedup log and advances
    // its tracker row (claimed at draft time) to published.
    const trackerByKind: Partial<Record<TethrOutputKind, TrackerName>> = {
      blog_draft: "content-calendar",
      brief: "destination-tracker",
      itinerary: "itinerary-calendar",
    };
    const trackerName = trackerByKind[output.kind as TethrOutputKind];
    const trackers = trackerService(db);
    const publishedSlug = slugify(output.title);
    await trackers.appendPublished(
      companyId,
      {
        slug: publishedSlug,
        title: output.title,
        kind: output.kind,
        publishedAt: new Date().toISOString(),
      },
      publishedBy,
    );
    if (trackerName) {
      const tracker = await trackers.readTracker(companyId, trackerName);
      const row = tracker.rows.find(
        (r) =>
          r.status === "review" &&
          (output.title.toLowerCase().includes(r.topic.toLowerCase()) ||
            publishedSlug.includes(r.slug)),
      );
      if (row) {
        await trackers.markRowPublished(companyId, trackerName, row.slug, publishedBy);
      }
    }
    // Phase 6: also record a company-scoped published-content memory so the
    // routing engine can flag a duplicate-topic request before re-creating it.
    {
      const { recordPublished } = await import("./published-memory.js");
      const pubKind =
        output.kind === "blog_draft"
          ? "blog"
          : output.kind === "brief"
            ? "brief"
            : output.kind === "itinerary"
              ? "itinerary"
              : "content";
      await recordPublished(
        db,
        companyId,
        { kind: pubKind, slug: publishedSlug, title: output.title, date: new Date().toISOString().slice(0, 10) },
        null,
      );
    }
    // Phase 11: mirror the published deliverable into the configured Google Drive
    // folder — best-effort, never fails a publish; only the folder shared with the
    // service account is writable, so nothing else in Drive is touched.
    try {
      const gdrive = await import("./tools/google-drive.js");
      if (gdrive.googleDriveConfigured()) {
        await gdrive.driveCreateFile(
          `${publishedSlug || slugify(output.title)}.md`,
          `# ${output.title}\n\n${output.body}\n`,
        );
      }
    } catch {
      /* Drive mirror is best-effort */
    }
    return updated;
  }

  type DecideInput = {
    companyId: string;
    outputId: string;
    decision: "approve" | "reject" | "request_changes";
    reviewer: string;
    note?: string;
  };

  /**
   * Decide a gated output, then (phase 16a) move the Paperclip task it belongs
   * to, if any: approve → done, reject → cancelled, changes → stays in review.
   * The task sync is best-effort and keyed on the output's FINAL status, so a
   * drive_change whose apply failed (closed "rejected") cancels, not completes.
   */
  async function decide(input: DecideInput) {
    const result = await decideOutput(input);
    try {
      const after = await getOutput(input.companyId, input.outputId);
      const meta = (after?.meta ?? {}) as Record<string, unknown>;
      if (after && typeof meta.taskIssueId === "string") {
        const effective =
          after.status === "rejected"
            ? "reject"
            : after.status === "changes_requested"
              ? "request_changes"
              : "approve";
        const { taskService } = await import("./tasks.js");
        await taskService(db).onOutputDecided({
          output: { id: after.id, title: after.title, meta: after.meta },
          decision: effective,
          reviewer: input.reviewer,
          note: input.note ?? null,
        });
      }
    } catch (err) {
      logger.warn({ err, outputId: input.outputId }, "[tethr] task sync after decision failed (decision unaffected)");
    }
    return result;
  }

  async function decideOutput(input: DecideInput) {
    const output = await getOutput(input.companyId, input.outputId);
    if (!output) throw new Error("Output not found");
    if (!output.approvalId) throw new Error("Output is not gated");
    if (!["gated", "changes_requested"].includes(output.status)) {
      throw new Error(`Output is ${output.status}; only gated output can be decided`);
    }

    const approvalStatus =
      input.decision === "approve"
        ? "approved"
        : input.decision === "reject"
          ? "rejected"
          : "revision_requested";

    await db
      .update(approvals)
      .set({
        status: approvalStatus,
        decidedByUserId: input.reviewer,
        decisionNote: input.note ?? null,
        decidedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(approvals.id, output.approvalId));

    await logActivity(db, {
      companyId: input.companyId,
      // Auto-approvals (reviewer "auto:@tag") are system actions, not a human's.
      actorType: input.reviewer.startsWith("auto:") ? "system" : "user",
      actorId: input.reviewer,
      action: `tethr_output_${input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : "changes_requested"}`,
      entityType: "tethr_output",
      entityId: output.id,
      agentId: output.agentId,
      details: {
        title: output.title,
        sensitivity: output.sensitivity,
        reviewer: input.reviewer,
        note: input.note ?? null,
      },
    });

    if (input.decision === "approve") {
      // Approving an agent proposal doesn't "publish" — it BUILDS the agent.
      if (output.kind === "agent_proposal") {
        return approveAgentProposal(output, input.companyId, input.reviewer);
      }
      // Approving an org change doesn't "publish" — it APPLIES the change.
      if (output.kind === "org_change") {
        return approveOrgChange(output, input.companyId, input.reviewer);
      }
      // Approving a drive change doesn't "publish" — it ARCHIVES the file.
      if (output.kind === "drive_change") {
        return approveDriveChange(output, input.companyId, input.reviewer);
      }
      // Phase 18: approving an outward action arms a one-time grant and wakes the chat.
      if (output.kind === "external_action") {
        return approveExternalAction(output, input.companyId, input.reviewer);
      }
      // Phase 23: approving a team card builds or changes the agent.
      if (output.kind === "team_agent" || output.kind === "team_change") {
        return approveTeamCard(output, input.companyId, input.reviewer);
      }
      // The learner's skill (Ask first, or a change to someone else's skill): approving saves it.
      if (output.kind === "skill_change") {
        return approveSkillChange(output, input.companyId);
      }
      const published = await publishToDrive(output.id, input.companyId, input.reviewer);
      await notify.send({
        companyId: input.companyId,
        kind: "approval",
        title: `Approved and published: ${output.title}`,
        body: input.note,
        href: `/queue/${output.id}`,
      });
      return published;
    }

    const nextStatus = input.decision === "reject" ? "rejected" : "changes_requested";
    const [updated] = await db
      .update(tethrOutputs)
      .set({ status: nextStatus, updatedAt: new Date() })
      .where(eq(tethrOutputs.id, output.id))
      .returning();
    if (output.kind === "skill_change") {
      const meta = (output.meta ?? {}) as Record<string, unknown>;
      if (typeof meta.studyId === "string" && typeof meta.skill === "string") {
        const { refuseSkillCard } = await import("./learn/study.js");
        await refuseSkillCard(input.companyId, meta.studyId, meta.skill).catch(() => {});
      }
    }
    if ((output.kind === "team_agent" || output.kind === "team_change") && input.decision === "reject") {
      // The one who asked hears it: a lead (for its sub-team), else tethr's main chat.
      const chats = await import("./chats.js");
      const leadTag = (output.meta as { leadTag?: unknown } | null)?.leadTag;
      const lead = typeof leadTag === "string" ? await (await import("./team.js")).teamService(db).get(input.companyId, leadTag) : null;
      await chats
        .addNote(input.companyId, lead?.threadId ?? chats.mainThreadId(input.companyId), `Rejected in tethr: ${output.title}${input.note ? ` (${input.note})` : ""}. Don't propose it again unless someone asks.`)
        .catch(() => {});
    }
    if (output.kind === "drive_change" && input.decision === "reject") {
      const meta = (output.meta ?? {}) as Record<string, unknown>;
      if (meta.cleanup && typeof meta.threadId === "string") {
        const chats = await import("./chats.js");
        await chats
          .addNote(input.companyId, meta.threadId, `Rejected: keep those files (${output.title})${input.note ? `: ${input.note}` : ""}. Don't ask again unless someone does.`)
          .catch(() => {});
      }
    }
    if (output.kind === "external_action" && input.decision === "reject") {
      // Tell the chat on its next turn (no wake: it's just context).
      const meta = (output.meta ?? {}) as Record<string, unknown>;
      if (typeof meta.threadId === "string") {
        const chats = await import("./chats.js");
        await chats
          .addNote(input.companyId, meta.threadId, `Rejected in tethr: ${String(meta.summary ?? output.title)}${input.note ? ` (${input.note})` : ""}. Don't do it unless someone asks again.`)
          .catch(() => {});
      }
    }
    await notify.send({
      companyId: input.companyId,
      kind: "approval",
      title:
        input.decision === "reject"
          ? `Rejected: ${output.title}`
          : `Changes requested: ${output.title}`,
      body: input.note,
      href: `/queue/${output.id}`,
    });
    return updated;
  }

  // Phase 18: approving an `external_action` (an outward connector call the Chat's
  // Claude session wanted to make) arms a ONE-TIME grant for that exact call,
  // bound to the thread, valid 24h, and wakes the chat so it runs it. The grant
  // is consumed by the approval gate (assistant/grants.ts consumeGrant).
  async function approveExternalAction(output: typeof tethrOutputs.$inferSelect, companyId: string, reviewer: string) {
    const meta = (output.meta ?? {}) as Record<string, unknown>;
    const now = new Date();
    const [updated] = await db
      .update(tethrOutputs)
      .set({
        status: "approved",
        meta: {
          ...meta,
          grant: {
            status: "active",
            expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
            approvedBy: reviewer,
            approvedAt: now.toISOString(),
          },
        },
        updatedAt: now,
      })
      .where(eq(tethrOutputs.id, output.id))
      .returning();
    await notify.send({
      companyId,
      kind: "approval",
      title: `Approved: ${output.title}`,
      href: `/queue/${output.id}`,
    });
    const threadId = typeof meta.threadId === "string" ? meta.threadId : null;
    if (threadId) {
      try {
        const chats = await import("./chats.js");
        await chats.addNote(
          companyId,
          threadId,
          `Approved in tethr: run this exact call now, changing nothing — tool ${String(meta.toolName)} with input ${JSON.stringify(meta.toolInput ?? {})}. Then confirm in one line.`,
        );
        const { getAssistantRunner } = await import("./assistant/runner.js");
        const { slackReplyTargetOf } = await import("./slack-chat.js");
        await getAssistantRunner(db).send({
          companyId,
          threadId,
          kind: "system",
          text: `Approved: ${String(meta.summary ?? output.title)}`,
          requestedByUserId: reviewer.startsWith("auto:") ? null : reviewer,
          // Asked from Slack (phase 26.1): the result is posted back there too.
          slack: slackReplyTargetOf(meta.slack),
        });
      } catch (err) {
        logger.warn({ err, outputId: output.id }, "[tethr] couldn't wake the chat after an approval (grant is still armed)");
      }
    }
    return updated;
  }

  // Phase 23: approving a `team_agent` card adds the agent to tethr's team
  // (active, its schedule on, its first task started); a `team_change` card
  // applies the change. The spec is checked again first (a tag may have been
  // taken since): a card that can't apply closes as rejected with the reason,
  // so the Queue never wedges. The main chat hears either way.
  async function approveSkillChange(output: typeof tethrOutputs.$inferSelect, companyId: string) {
    const meta = (output.meta ?? {}) as Record<string, unknown>;
    const chats = await import("./chats.js");
    try {
      if (typeof meta.studyId !== "string" || typeof meta.skill !== "string") throw new Error("This card has no skill on it.");
      const { approveSkillCard } = await import("./learn/study.js");
      const k = await approveSkillCard(db, companyId, meta.studyId, meta.skill);
      await chats
        .addNote(companyId, chats.mainThreadId(companyId), `Approved: Sage's skill ${k.name} is saved. Load it with skill_view before doing that kind of work.`)
        .catch(() => {});
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const [closed] = await db
        .update(tethrOutputs)
        .set({ status: "rejected", meta: { ...meta, applyError: reason }, updatedAt: new Date() })
        .where(eq(tethrOutputs.id, output.id))
        .returning();
      await notify.send({ companyId, kind: "approval", title: `Couldn't save: ${output.title}`, body: reason, href: `/queue/${output.id}` });
      return closed;
    }
    const [updated] = await db.update(tethrOutputs).set({ status: "published", updatedAt: new Date() }).where(eq(tethrOutputs.id, output.id)).returning();
    return updated;
  }

  async function approveTeamCard(output: typeof tethrOutputs.$inferSelect, companyId: string, reviewer: string) {
    const { teamConnectorLabels, teamService } = await import("./team.js");
    const { needResolver } = await import("./connections.js");
    const { goalLine, scheduleWords, specToInput, validateTeamSpec } = await import("./team-spec.js");
    const { specFromCard } = await import("./assistant/team-tools.js");
    const { goalsService } = await import("./goals.js");
    const chats = await import("./chats.js");
    const team = teamService(db);
    const meta = (output.meta ?? {}) as Record<string, unknown>;
    const actor = reviewer.startsWith("auto:") ? {} : { userId: reviewer };
    let note: string;
    let noteThread = chats.mainThreadId(companyId);
    try {
      if (output.kind === "team_agent") {
        const raw = specFromCard(meta);
        if (!raw) throw new Error("This card has no agent spec.");
        // Phase 24: a sub-agent joins its lead, which must still be a lead.
        const leadTag = typeof meta.leadTag === "string" ? meta.leadTag : null;
        const lead = leadTag ? await team.get(companyId, leadTag) : null;
        if (leadTag && !lead?.lead) throw new Error(`${leadTag} is no longer a lead on the team.`);
        const { goals } = await goalsService(db).list(companyId);
        const spec = validateTeamSpec(specToInput(raw), {
          takenTags: await team.takenTags(companyId),
          connectors: teamConnectorLabels(companyId),
          goals: new Map(goals.map((g) => [g.id, g.title])),
          lead: lead ? { tag: lead.tag, connectors: lead.connectors } : null,
          ...needResolver(companyId),
        });
        const agent = await team.create(companyId, spec, { ...actor, via: "approval" }, { lead });
        // Phase 27: an agent that starts out missing a connection waits on it; the person gets the card now.
        const unmet = await team.unmetNeeds(companyId, agent);
        const { openNeedCards } = await import("./team-needs.js");
        await openNeedCards(db, companyId, unmet);
        const goal = spec.goal ? ` ${goalLine(spec.goal, { pending: false })}.` : "";
        const start = unmet.length
          ? ` It's waiting for ${[...new Set(unmet.map((n) => n.key))].join(", ")}: it won't run until that's connected or the person says to carry on without it (they have a card for it).`
          : spec.firstTask
            ? ` Its first task, "${spec.firstTask.title}", has started; the report will come back to ${lead ? lead.tag : "you"}.`
            : " Give it work with assign_task.";
        note = `Approved: ${agent.tag} (${agent.name}) is on ${lead ? `${lead.tag}'s team` : "the team"}${agent.schedule ? ` and runs ${scheduleWords(agent.schedule.cron)}` : ""}.${goal}${start}`;
        if (lead) noteThread = lead.threadId;
        // A lead whose new sub-agent has no first task is woken to hand it one,
        // so approving it starts the work instead of waiting for the schedule.
        if (lead && !spec.firstTask && !lead.paused) {
          const { getAssistantRunner } = await import("./assistant/runner.js");
          await getAssistantRunner(db)
            .send({
              companyId,
              threadId: lead.threadId,
              kind: "system",
              text: `${agent.tag} joined your team\n[Brief] The person approved ${agent.tag} (${agent.title}). If its work is ready, hand it its first task now (assign_task). Otherwise say in a line when you will. Nothing goes to tethr unless you write a "Report:".`,
            })
            .catch((err) => logger.warn({ err, tag: agent.tag }, "[tethr] couldn't wake the lead after a sub-agent was approved"));
        }
      } else {
        const tag = String(meta.tag ?? "");
        const patch = (meta.patch ?? {}) as Parameters<typeof team.update>[2];
        if (Object.keys(patch).length) await team.update(companyId, tag, patch, actor);
        if (meta.resume === true) await team.setPaused(companyId, tag, false, actor);
        note = `Approved: ${output.title}. It's applied.`;
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const [closed] = await db
        .update(tethrOutputs)
        .set({ status: "rejected", meta: { ...meta, applyError: reason }, updatedAt: new Date() })
        .where(eq(tethrOutputs.id, output.id))
        .returning();
      await chats.addNote(companyId, chats.mainThreadId(companyId), `"${output.title}" was approved but couldn't be applied: ${reason}`).catch(() => {});
      await notify.send({ companyId, kind: "approval", title: `Couldn't apply: ${output.title}`, body: reason, href: `/queue/${output.id}` });
      return closed;
    }
    const [updated] = await db
      .update(tethrOutputs)
      .set({ status: "published", updatedAt: new Date() })
      .where(eq(tethrOutputs.id, output.id))
      .returning();
    await chats.addNote(companyId, noteThread, note).catch(() => {});
    await notify.send({ companyId, kind: "approval", title: `Approved: ${output.title}`, href: `/chat` });
    return updated;
  }

  // Approving an `agent_proposal` builds the agent from the spec in its meta,
  // reporting to the CEO that proposed it, seeded paused. The proposal output is
  // marked published (it did its job) — nothing is written to the Drive.
  async function approveAgentProposal(
    output: typeof tethrOutputs.$inferSelect,
    companyId: string,
    reviewer: string,
  ) {
    const spec = (output.meta as { spec?: TethrAgentSpec } | null)?.spec;
    if (!spec) throw new Error("This proposal has no agent spec to build");
    const result = await instantiateAgentFromSpec(db, companyId, spec, {
      reportsTo: output.agentId, // the CEO proposed it → the new agent reports to it
    });
    const [updated] = await db
      .update(tethrOutputs)
      .set({ status: "published", updatedAt: new Date() })
      .where(eq(tethrOutputs.id, output.id))
      .returning();
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: reviewer,
      action: "tethr_agent_created",
      entityType: "agent",
      entityId: result.agentId,
      agentId: result.agentId,
      details: { tag: result.tag, via: "ceo_proposal", outputId: output.id },
    });
    await notify.send({
      companyId,
      kind: "approval",
      title: `New agent created: ${spec.codename} (${result.tag})`,
      body: "Reporting to the CEO, seeded paused. Enable its heartbeat when you're ready.",
      href: "/company-view",
    });
    return updated;
  }

  // Approving an `org_change` applies the staged modification (Tinkr) and
  // records it in the revertible change log. Nothing writes to the Drive.
  async function approveOrgChange(
    output: typeof tethrOutputs.$inferSelect,
    companyId: string,
    reviewer: string,
  ) {
    const meta = output.meta as {
      change?: import("./org-changes.js").OrgChangeSpec;
      revertOfChangeId?: string;
    } | null;
    if (!meta?.change) throw new Error("This output has no staged change to apply");
    const { applyOrgChange } = await import("./org-changes.js");
    const change = await applyOrgChange(db, {
      companyId,
      spec: meta.change,
      outputId: output.id,
      appliedBy: reviewer,
      revertOfChangeId: meta.revertOfChangeId ?? null,
    });
    const [updated] = await db
      .update(tethrOutputs)
      .set({ status: "published", updatedAt: new Date() })
      .where(eq(tethrOutputs.id, output.id))
      .returning();
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: reviewer,
      action: "tethr_org_change_applied",
      entityType: "tethr_org_change",
      entityId: change.id,
      agentId: change.targetAgentId,
      details: { summary: change.summary, op: change.op, outputId: output.id },
    });
    await notify.send({
      companyId,
      kind: "approval",
      title: `Applied: ${change.summary}`,
      body: "Logged on the Company page — revertible any time.",
      href: "/company-view",
    });
    return updated;
  }

  // Approving a `drive_change` archives the staged file (Filer) — a soft move
  // to the store's archive folder, never a hard delete. Re-validated at apply
  // time: a vanished/moved target closes the output cleanly instead of wedging
  // the Queue (status rejected + meta.applyError; nothing on disk changes).
  async function approveDriveChange(
    output: typeof tethrOutputs.$inferSelect,
    companyId: string,
    reviewer: string,
  ) {
    const meta = output.meta as {
      driveChange?: import("./drive-changes.js").DriveChangeSpec;
      cleanup?: import("./assistant/cleanup.js").CleanupSpec;
      threadId?: string;
    } | null;
    if (meta?.cleanup) return approveCleanup(output, companyId, reviewer, meta.cleanup, meta.threadId ?? null);
    if (!meta?.driveChange) throw new Error("This output has no staged file archive to apply");
    const { applyDriveChange } = await import("./drive-changes.js");
    const applied = await applyDriveChange(db, {
      companyId,
      spec: meta.driveChange,
      actorTag: reviewer,
    });
    if (!applied.ok) {
      const [updated] = await db
        .update(tethrOutputs)
        .set({
          status: "rejected",
          updatedAt: new Date(),
          meta: { ...((output.meta as Record<string, unknown>) ?? {}), applyError: applied.error },
        })
        .where(eq(tethrOutputs.id, output.id))
        .returning();
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: reviewer,
        action: "tethr_drive_change_failed",
        entityType: "tethr_output",
        entityId: output.id,
        agentId: output.agentId,
        details: { error: applied.error, spec: meta.driveChange },
      });
      await notify.send({
        companyId,
        kind: "approval",
        title: `Couldn't archive: ${output.title}`,
        body: `${applied.error}. Nothing was changed.`,
        href: `/queue/${output.id}`,
      });
      return updated;
    }
    const [updated] = await db
      .update(tethrOutputs)
      .set({
        status: "published",
        updatedAt: new Date(),
        meta: {
          ...((output.meta as Record<string, unknown>) ?? {}),
          applied: { from: applied.from, to: applied.to, at: new Date().toISOString() },
        },
      })
      .where(eq(tethrOutputs.id, output.id))
      .returning();
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: reviewer,
      action: "tethr_drive_change_applied",
      entityType: "tethr_output",
      entityId: output.id,
      agentId: output.agentId,
      details: { store: meta.driveChange.store, from: applied.from, to: applied.to },
    });
    await notify.send({
      companyId,
      kind: "approval",
      title: `Archived: ${output.title}`,
      body: `Moved to ${applied.to} — recoverable any time.`,
      href: `/queue/${output.id}`,
    });
    return updated;
  }

  /** Phase 27: files tethr or an agent asked to remove from its folder. Approving moves
   * what's still there to the archive; the chat that asked hears what happened. */
  async function approveCleanup(output: typeof tethrOutputs.$inferSelect, companyId: string, reviewer: string, spec: import("./assistant/cleanup.js").CleanupSpec, threadId: string | null) {
    const { applyCleanup, cleanupDestination } = await import("./assistant/cleanup.js");
    const chats = await import("./chats.js");
    const { moved, missing } = await applyCleanup(spec);
    const base = (output.meta as Record<string, unknown>) ?? {};
    if (!moved.length) {
      const reason = missing.join(" ") || "none of the files were there";
      const [closed] = await db
        .update(tethrOutputs)
        .set({ status: "rejected", updatedAt: new Date(), meta: { ...base, applyError: reason } })
        .where(eq(tethrOutputs.id, output.id))
        .returning();
      if (threadId) await chats.addNote(companyId, threadId, `"${output.title}" was approved but nothing was moved: ${reason}`).catch(() => {});
      return closed;
    }
    const [updated] = await db
      .update(tethrOutputs)
      .set({ status: "published", updatedAt: new Date(), meta: { ...base, applied: { moved, missing, at: new Date().toISOString() } } })
      .where(eq(tethrOutputs.id, output.id))
      .returning();
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: reviewer,
      action: "tethr_files_cleaned_up",
      entityType: "tethr_output",
      entityId: output.id,
      agentId: output.agentId,
      details: { moved: moved.map((m) => m.from), missing: missing.length },
    });
    if (threadId) {
      const note = `Approved: moved ${moved.length} file${moved.length === 1 ? "" : "s"} out of files/ to ${cleanupDestination()} (${moved.map((m) => m.from).join(", ")}).${missing.length ? ` Not moved: ${missing.join(" ")}` : ""}`;
      await chats.addNote(companyId, threadId, note).catch(() => {});
    }
    return updated;
  }

  async function listOutputs(
    companyId: string,
    opts: { status?: string; limit?: number } = {},
  ) {
    const conditions = [eq(tethrOutputs.companyId, companyId)];
    if (opts.status) conditions.push(eq(tethrOutputs.status, opts.status));
    const rows = await db
      .select({
        output: tethrOutputs,
        subagentTag: tethrSubagents.tag,
        subagentName: tethrSubagents.name,
      })
      .from(tethrOutputs)
      .leftJoin(tethrSubagents, eq(tethrOutputs.subagentId, tethrSubagents.id))
      .where(and(...conditions))
      .orderBy(
        // Pending review first, then newest, so the limit never cuts what's waiting on a person.
        desc(sql`${tethrOutputs.status} in ('gated', 'changes_requested')`),
        desc(tethrOutputs.createdAt),
      )
      .limit(opts.limit ?? 100);
    return rows
      .map((r) => ({ ...r.output, subagentTag: r.subagentTag, subagentName: r.subagentName }))
      .sort((a, b) => {
        const gate = (s: string) => (s === "gated" ? 0 : s === "changes_requested" ? 1 : 2);
        const byGate = gate(a.status) - gate(b.status);
        if (byGate !== 0) return byGate;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
  }

  return {
    createOutput,
    getOutput,
    listOutputs,
    decide,
    publishToDrive,
    assertPublishable,
  };
}

/** The Slack DM for a card that needs a person: who's asking, what for, and a
 * link straight to it when tethr has a public URL. */
export function approvalDmText(agentTag: string, title: string, outputId: string): string {
  const base = (process.env.PAPERCLIP_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  const where = base ? `<${base}/queue/${outputId}|Review it in tethr>` : "Review it in tethr's Queue or the chat.";
  return `${agentTag} needs your approval: *${title}*. ${where}`;
}

function labelForSensitivity(s: TethrSensitivity): string {
  switch (s) {
    case "medical":
      return "medical-sensitive";
    case "public":
      return "public-facing";
    case "spend":
      return "spend-sensitive";
    case "pr":
      return "PR-sensitive";
    case "destructive":
      return "destructive (file archive)";
    default:
      return s;
  }
}

export type GatingService = ReturnType<typeof gatingService>;
