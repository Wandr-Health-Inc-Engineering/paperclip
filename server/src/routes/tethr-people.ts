import type { Request, Response } from "express";
import { getActorInfo } from "./authz.js";

/** The chat and setup run on the admin's own Claude session and settings, so only a
 * person (never an agent's API key) may drive them. Returns false after replying 403. */
export function requirePerson(req: Request, res: Response): boolean {
  if (getActorInfo(req).actorType === "user") return true;
  res.status(403).json({ error: "Only a person can use the chat" });
  return false;
}

/** An instance admin: a person with the admin role (local_trusted's implicit
 * board user is one). Never an agent. */
export function isInstanceAdmin(req: Request): boolean {
  return req.actor?.type === "board" && req.actor.isInstanceAdmin === true;
}
