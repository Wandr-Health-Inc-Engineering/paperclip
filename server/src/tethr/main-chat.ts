import { and, count, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tethrOutputs, tethrRouteRuns } from "@paperclipai/db";
import * as chats from "./chats.js";
import { getSetup, updateSetup } from "./setup.js";

// The goals interview used to open its own side chat ("Goals interview"). It
// now runs in the main chat, the one ongoing conversation with tethr (Mark,
// 2026-11-08: "it should be clear it's the main ongoing chat"). An interview
// started the old way is folded into the main chat while the main chat is
// still empty: its turns, its Claude session (so tethr keeps the context), its
// notes, taint and pending approvals all move over, and the side chat leaves
// the list.

/** Fold an earlier interview side chat into an empty main chat. Idempotent;
 * returns whether anything moved. */
export async function foldInterviewIntoMainChat(db: Db, companyId: string): Promise<boolean> {
  const from = getSetup(companyId).interviewThreadId;
  const main = chats.mainThreadId(companyId);
  if (!from || from === main || !chats.isSideChat(companyId, from)) return false;
  if ((await countThreadRuns(db, companyId, main)) > 0) return false;

  await db
    .update(tethrRouteRuns)
    .set({ threadId: main })
    .where(and(eq(tethrRouteRuns.companyId, companyId), eq(tethrRouteRuns.threadId, from)));
  // Approval grants are keyed by thread (grants.ts reads meta.threadId).
  await db
    .update(tethrOutputs)
    .set({ meta: sql`jsonb_set(${tethrOutputs.meta}, '{threadId}', to_jsonb(${main}::text))` })
    .where(and(eq(tethrOutputs.companyId, companyId), sql`${tethrOutputs.meta}->>'threadId' = ${from}`));
  await chats.moveThreadState(companyId, from, main);
  await updateSetup(companyId, (s) => ({ ...s, interviewThreadId: main }));
  return true;
}

async function countThreadRuns(db: Db, companyId: string, threadId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(tethrRouteRuns)
    .where(and(eq(tethrRouteRuns.companyId, companyId), eq(tethrRouteRuns.threadId, threadId)));
  return Number(row?.n ?? 0);
}

/** Boot heal: fold every company's earlier interview side chat. Best-effort. */
export async function foldInterviewsIntoMainChats(db: Db): Promise<void> {
  const { companies } = await import("@paperclipai/db");
  const { logger } = await import("../middleware/logger.js");
  const rows = await db.select({ id: companies.id }).from(companies);
  for (const { id } of rows) {
    try {
      if (await foldInterviewIntoMainChat(db, id)) logger.info({ companyId: id }, "tethr: moved the goals interview into the main chat");
    } catch (err) {
      logger.warn({ err, companyId: id }, "tethr: couldn't move the goals interview into the main chat");
    }
  }
}
