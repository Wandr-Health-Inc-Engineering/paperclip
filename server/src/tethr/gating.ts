import { and, eq } from "drizzle-orm";
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
      if (gated && !autoApproved) {
        await dmOverseer(
          db,
          input.companyId,
          input.agentTag,
          `${input.agentTag} needs your approval: *${input.title}*. Review it in the Tethr Queue.`,
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

  async function decide(input: {
    companyId: string;
    outputId: string;
    decision: "approve" | "reject" | "request_changes";
    reviewer: string;
    note?: string;
  }) {
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
    } | null;
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
        // pending review first, then newest
        eq(tethrOutputs.status, "gated"),
        tethrOutputs.createdAt,
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
