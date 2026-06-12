import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, tethrOutputs, tethrSubagents } from "@paperclipai/db";
import {
  TETHR_GATED_SENSITIVITIES,
  TETHR_OUTPUT_APPROVAL_TYPE,
  type TethrOutputKind,
  type TethrSensitivity,
} from "@paperclipai/shared";
import { logActivity } from "../services/activity-log.js";
import { driveService } from "./drive.js";
import { notificationService } from "./notify.js";

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
      actorType: "user",
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
    default:
      return s;
  }
}

export type GatingService = ReturnType<typeof gatingService>;
