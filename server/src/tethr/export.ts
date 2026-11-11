import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  tethrAgentProfiles,
  tethrDivisions,
  tethrDriveNodes,
  tethrMemories,
  tethrOutputs,
  tethrSubagents,
} from "@paperclipai/db";
import { driveService } from "./drive.js";

// Tethr data export: the portable bundle the cloud team imports to carry
// Wandr Growth's accumulated state (org, specs, drive content, memories,
// decided outputs) across environments. History (route runs, notifications)
// stays behind — it's an audit trail, not state.

const MAX_EXPORT_FILE_BYTES = 256 * 1024;

export interface TethrExportBundle {
  version: 1;
  exportedAt: string;
  divisions: Array<Record<string, unknown>>;
  agents: Array<{
    profile: Record<string, unknown>;
    agent: Record<string, unknown>;
    subagents: Array<Record<string, unknown>>;
  }>;
  memories: Array<Record<string, unknown>>;
  outputs: Array<Record<string, unknown>>;
  driveFiles: Array<{
    path: string;
    contentType: string | null;
    tags: string[];
    permissions: Record<string, unknown>;
    content: string;
  }>;
}

export function exportService(db: Db) {
  const drive = driveService(db);

  async function exportCompany(companyId: string): Promise<TethrExportBundle> {
    const divisions = await db
      .select()
      .from(tethrDivisions)
      .where(eq(tethrDivisions.companyId, companyId));
    const profiles = await db
      .select({ profile: tethrAgentProfiles, agent: agents })
      .from(tethrAgentProfiles)
      .innerJoin(agents, eq(tethrAgentProfiles.agentId, agents.id))
      .where(eq(tethrAgentProfiles.companyId, companyId));
    const subagents = await db
      .select()
      .from(tethrSubagents)
      .where(eq(tethrSubagents.companyId, companyId));
    const memories = await db
      .select()
      .from(tethrMemories)
      .where(eq(tethrMemories.companyId, companyId));
    const outputs = await db
      .select()
      .from(tethrOutputs)
      .where(eq(tethrOutputs.companyId, companyId));

    const nodes = await db
      .select()
      .from(tethrDriveNodes)
      .where(eq(tethrDriveNodes.companyId, companyId));
    const driveFiles: TethrExportBundle["driveFiles"] = [];
    for (const node of nodes) {
      if (node.kind !== "file" || !node.currentVersionId) continue;
      if ((node.byteSize ?? 0) > MAX_EXPORT_FILE_BYTES) continue;
      const read = await drive.readCurrent(companyId, node.id);
      if (!read) continue;
      driveFiles.push({
        path: node.path,
        contentType: node.contentType,
        tags: node.tags,
        permissions: node.permissions as unknown as Record<string, unknown>,
        content: read.content.toString("base64"),
      });
    }

    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      divisions: divisions.map(({ id, companyId: _c, headAgentId, ...rest }) => ({
        ...rest,
        headAgentTag:
          profiles.find((p) => p.agent.id === headAgentId)?.profile.tag ?? null,
      })),
      agents: profiles.map(({ profile, agent }) => ({
        profile: {
          tag: profile.tag,
          codename: profile.codename,
          mission: profile.mission,
          approvalGate: profile.approvalGate,
          heartbeatCron: profile.heartbeatCron,
          heartbeatNote: profile.heartbeatNote,
          portPriority: profile.portPriority,
          routingTable: profile.routingTable,
          standingRules: profile.standingRules,
          divisionKey: divisions.find((d) => d.id === profile.divisionId)?.key ?? null,
        },
        agent: {
          name: agent.name,
          title: agent.title,
          icon: agent.icon,
          status: agent.status,
          adapterConfig: agent.adapterConfig,
          budgetMonthlyCents: agent.budgetMonthlyCents,
          reportsToTag:
            profiles.find((p) => p.agent.id === agent.reportsTo)?.profile.tag ?? null,
        },
        subagents: subagents
          .filter((s) => s.agentId === agent.id)
          .map(({ id, companyId: _c, agentId: _a, ...rest }) => rest),
      })),
      memories: memories.map(({ id, companyId: _c, agentId, ...rest }) => ({
        ...rest,
        agentTag: profiles.find((p) => p.agent.id === agentId)?.profile.tag ?? null,
      })),
      outputs: outputs.map(
        ({ id, companyId: _c, agentId, subagentId, routeRunId, heartbeatRunId, approvalId, driveNodeId, revisionOfId, ...rest }) => ({
          ...rest,
          agentTag: profiles.find((p) => p.agent.id === agentId)?.profile.tag ?? null,
          subagentTag: subagents.find((s) => s.id === subagentId)?.tag ?? null,
        }),
      ),
      driveFiles,
    };
  }

  /** Restore drive files + memories into an existing Tethr company. */
  async function importDriveAndMemories(
    companyId: string,
    bundle: TethrExportBundle,
  ): Promise<{ files: number; memories: number }> {
    let files = 0;
    for (const file of bundle.driveFiles) {
      await drive.putFile({
        companyId,
        path: file.path,
        content: Buffer.from(file.content, "base64"),
        contentType: file.contentType ?? undefined,
        tags: file.tags,
        createdByTag: "tethr-import",
        note: `Imported ${bundle.exportedAt}`,
      });
      files++;
    }
    let importedMemories = 0;
    for (const memory of bundle.memories) {
      await db.insert(tethrMemories).values({
        companyId,
        agentId: null, // tag→id remapping is the full importer's job; keep company-wide
        kind: String(memory.kind ?? "fact"),
        content: String(memory.content ?? ""),
        source: memory.source ? String(memory.source) : "import",
      });
      importedMemories++;
    }
    return { files, memories: importedMemories };
  }

  return { exportCompany, importDriveAndMemories };
}
