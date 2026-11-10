import { Router, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { resolveInFiles } from "../tethr/assistant/files.js";
import { workspaceDir } from "../tethr/assistant/workspace.js";
import { destinationFolders, folderLabel, InboxError, inboxService } from "../tethr/inbox/pipeline.js";
import { inboxStore } from "../tethr/inbox/store.js";
import { mirrorDir } from "../tethr/mirror.js";
import { TeamInputError } from "../tethr/team-spec.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { requirePerson } from "./tethr-people.js";

// Phase 26.3: tethr's Inbox for the page and the chat card. The items with
// tethr's suggestions, the folders it files into, the rules; and a person's
// taps: file it (Jev's pick or another folder), leave it, put it back, tell
// someone or hand it to an agent, "File this" on a chat upload, accept or turn
// down a rule. Every tap is a person's (agents get 403).

export function tethrInboxRoutes(db: Db): Router {
  const router = Router();
  const inbox = inboxService(db);

  const fail = (res: Response, err: unknown) => {
    if (err instanceof InboxError || err instanceof TeamInputError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  };

  router.get("/tethr/:companyId/inbox", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const root = mirrorDir();
    const { open, filed } = await inbox.list(companyId);
    const state = inboxStore.get(companyId);
    res.json({
      connected: !!root,
      folders: root ? (await destinationFolders(root)).map(folderLabel) : [],
      open,
      filed,
      rules: (state.rules ?? []).filter((r) => r.status !== "rejected"),
    });
  });

  const person = (handler: (companyId: string, id: string, body: Record<string, unknown>, userId: string | null) => Promise<unknown>) =>
    async (req: Parameters<Parameters<typeof router.post>[1]>[0], res: Response) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      if (!requirePerson(req, res)) return;
      try {
        res.json(await handler(companyId, String(req.params.id ?? ""), (req.body ?? {}) as Record<string, unknown>, getActorInfo(req).actorId ?? null));
      } catch (err) {
        fail(res, err);
      }
    };

  router.post(
    "/tethr/:companyId/inbox/:id/file",
    person((companyId, id, body) => inbox.fileTo(companyId, id, String(body.destination ?? ""), { by: "a person" })),
  );
  router.post("/tethr/:companyId/inbox/:id/leave", person((companyId, id) => inbox.leave(companyId, id)));
  router.post("/tethr/:companyId/inbox/:id/put-back", person((companyId, id) => inbox.putBack(companyId, id)));
  router.post(
    "/tethr/:companyId/inbox/:id/route",
    person((companyId, id, body, userId) => inbox.routeTo(companyId, id, String(body.to ?? ""), { userId })),
  );
  router.post(
    "/tethr/:companyId/inbox/rules/:id",
    person((companyId, id, body) => inbox.decideRule(companyId, id, body.accept === true)),
  );
  router.post("/tethr/:companyId/inbox/scan", person((companyId) => inbox.scan(companyId)));
  // "File this" on a chat upload: a copy goes to the Inbox (the chat keeps its own).
  router.post(
    "/tethr/:companyId/inbox/file-this",
    person(async (companyId, _id, body) => {
      const resolved = resolveInFiles(workspaceDir().dir, String(body.path ?? ""), "path");
      if ("error" in resolved) throw new InboxError(resolved.error);
      return inbox.takeWorkspaceFile(companyId, resolved.abs, "chat");
    }),
  );

  return router;
}
