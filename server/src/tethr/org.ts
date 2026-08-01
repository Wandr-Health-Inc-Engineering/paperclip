import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  tethrAgentProfiles,
  tethrDivisions,
  tethrSubagents,
} from "@paperclipai/db";

// Org readers shared by the routing engine, adapter, and routes.

export function orgService(db: Db) {
  async function listDivisions(companyId: string) {
    return db
      .select()
      .from(tethrDivisions)
      .where(eq(tethrDivisions.companyId, companyId))
      .orderBy(asc(tethrDivisions.sortOrder));
  }

  async function listProfiles(companyId: string) {
    return db
      .select({
        profile: tethrAgentProfiles,
        agent: agents,
      })
      .from(tethrAgentProfiles)
      .innerJoin(agents, eq(tethrAgentProfiles.agentId, agents.id))
      .where(eq(tethrAgentProfiles.companyId, companyId));
  }

  async function getProfileByTag(companyId: string, tag: string) {
    const [row] = await db
      .select({ profile: tethrAgentProfiles, agent: agents })
      .from(tethrAgentProfiles)
      .innerJoin(agents, eq(tethrAgentProfiles.agentId, agents.id))
      .where(
        and(
          eq(tethrAgentProfiles.companyId, companyId),
          eq(tethrAgentProfiles.tag, tag),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * The router — the profile every request enters through. @tethr (the
   * clean-slate coordinator, Phase 11) first; @helm kept as a fallback so the
   * archived Wandr Growth org and anything seeded from it still routes.
   */
  async function getRouterProfile(companyId: string) {
    return (
      (await getProfileByTag(companyId, "@tethr")) ??
      (await getProfileByTag(companyId, "@helm"))
    );
  }

  async function getProfileByAgentId(companyId: string, agentId: string) {
    const [row] = await db
      .select({ profile: tethrAgentProfiles, agent: agents })
      .from(tethrAgentProfiles)
      .innerJoin(agents, eq(tethrAgentProfiles.agentId, agents.id))
      .where(
        and(
          eq(tethrAgentProfiles.companyId, companyId),
          eq(tethrAgentProfiles.agentId, agentId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async function listSubagents(companyId: string, agentId?: string) {
    const conditions = [eq(tethrSubagents.companyId, companyId)];
    if (agentId) conditions.push(eq(tethrSubagents.agentId, agentId));
    return db
      .select()
      .from(tethrSubagents)
      .where(and(...conditions))
      .orderBy(asc(tethrSubagents.sortOrder));
  }

  async function getSubagentByTag(companyId: string, tag: string) {
    const [row] = await db
      .select()
      .from(tethrSubagents)
      .where(
        and(eq(tethrSubagents.companyId, companyId), eq(tethrSubagents.tag, tag)),
      )
      .limit(1);
    return row ?? null;
  }

  return {
    listDivisions,
    listProfiles,
    getProfileByTag,
    getRouterProfile,
    getProfileByAgentId,
    listSubagents,
    getSubagentByTag,
  };
}

export type OrgService = ReturnType<typeof orgService>;
