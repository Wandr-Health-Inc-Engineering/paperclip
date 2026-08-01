import { and, desc, eq, ilike, isNull, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tethrMemories } from "@paperclipai/db";
import type { TethrMemoryKind } from "@paperclipai/shared";

// Per-company + per-agent recall. Company-wide memories have agentId = null.

export function memoryService(db: Db) {
  async function record(input: {
    companyId: string;
    agentId?: string | null;
    kind?: TethrMemoryKind;
    content: string;
    source?: string;
  }) {
    const [created] = await db
      .insert(tethrMemories)
      .values({
        companyId: input.companyId,
        agentId: input.agentId ?? null,
        kind: input.kind ?? "fact",
        content: input.content,
        source: input.source ?? null,
      })
      .returning();
    return created;
  }

  async function list(
    companyId: string,
    opts: { agentId?: string | null; limit?: number } = {},
  ) {
    const conditions = [eq(tethrMemories.companyId, companyId)];
    if (opts.agentId !== undefined) {
      conditions.push(
        opts.agentId === null
          ? isNull(tethrMemories.agentId)
          : eq(tethrMemories.agentId, opts.agentId),
      );
    }
    return db
      .select()
      .from(tethrMemories)
      .where(and(...conditions))
      .orderBy(desc(tethrMemories.createdAt))
      .limit(opts.limit ?? 100);
  }

  /** Recall memories relevant to an agent: its own plus company-wide ones. */
  async function recall(
    companyId: string,
    agentId: string | null,
    query?: string,
    limit = 20,
  ) {
    const scope = agentId
      ? or(isNull(tethrMemories.agentId), eq(tethrMemories.agentId, agentId))
      : isNull(tethrMemories.agentId);
    const conditions = [eq(tethrMemories.companyId, companyId), scope];
    if (query && query.trim()) {
      conditions.push(ilike(tethrMemories.content, `%${query.trim()}%`));
    }
    return db
      .select()
      .from(tethrMemories)
      .where(and(...conditions))
      .orderBy(desc(tethrMemories.createdAt))
      .limit(limit);
  }

  /**
   * Forget an agent's run-history memories (the ephemeral "what I just did"
   * notes that drive recency recall). Scoped to kind "history" for one agent —
   * facts, rules, preferences, and published-content are never touched. Used by
   * the chat reset command to wipe conversational bleed on demand.
   */
  async function clearHistory(companyId: string, agentId: string) {
    const deleted = await db
      .delete(tethrMemories)
      .where(
        and(
          eq(tethrMemories.companyId, companyId),
          eq(tethrMemories.agentId, agentId),
          eq(tethrMemories.kind, "history"),
        ),
      )
      .returning({ id: tethrMemories.id });
    return deleted.length;
  }

  return { record, list, recall, clearHistory };
}

export type MemoryService = ReturnType<typeof memoryService>;
