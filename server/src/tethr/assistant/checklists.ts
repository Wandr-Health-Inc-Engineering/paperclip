import { randomUUID } from "node:crypto";
import { companyStore } from "../company-store.js";
import { oneLine } from "../goals.js";

// Phase 27 follow-up (Mark, 2026-11-10: "in these situations I would like it to
// develop a way to help me get it set up, like a checklist... this isn't
// helpful"). When something has to be done by a person outside tethr (setting up
// a campaign in Google Ads, connecting a tool), tethr or an agent hands them a
// checklist: short steps in order, the exact values to paste, ticked off as they
// go. Ticking the last one tells the chat it's done, so tethr can check it took.
//
// Kept per company in the instance dir (tethr-checklists.json).

export const CHECKLIST_LIMITS = {
  title: 120,
  why: 300,
  minSteps: 2,
  maxSteps: 12,
  step: 160,
  detail: 400,
  copy: 2_000,
  openPerChat: 3,
  kept: 200,
};

export interface ChecklistStep {
  id: string;
  /** What to do, in one line. */
  do: string;
  /** Where to find it, or what to watch for. Plain text. */
  detail: string | null;
  /** Exact text to paste (a headline, a keyword list, a setting). */
  copy: string | null;
  done: boolean;
  doneAt: string | null;
}

export interface Checklist {
  id: string;
  threadId: string;
  runId: string | null;
  /** The agent that made it, or null for tethr. */
  agentTag: string | null;
  title: string;
  why: string | null;
  steps: ChecklistStep[];
  /** dismissed = the person put it away without finishing it. */
  status: "open" | "done" | "dismissed";
  createdAt: string;
  doneAt: string | null;
}

interface ChecklistsState {
  checklists?: Checklist[];
}

export const checklistStore = companyStore<ChecklistsState>("TETHR_CHECKLISTS_FILE", "tethr-checklists.json");

export class ChecklistInputError extends Error {}

function clip(value: unknown, max: number, field: string, multiline = false): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new ChecklistInputError(`${field} must be text.`);
  const text = multiline ? value.replace(/\r\n/g, "\n").trim() : oneLine(value, max + 1);
  if (text.length > max) throw new ChecklistInputError(`Keep ${field} to ${max} characters.`);
  return text || null;
}

export interface ParsedChecklist {
  title: string;
  why: string | null;
  steps: Array<Pick<ChecklistStep, "do" | "detail" | "copy">>;
}

/** Check and tidy what the tool was given. Throws ChecklistInputError with a plain message. */
export function parseChecklist(input: Record<string, unknown>): ParsedChecklist {
  const title = clip(input.title, CHECKLIST_LIMITS.title, "the title");
  if (!title) throw new ChecklistInputError("Give the checklist a title (what it gets done).");
  const raw = Array.isArray(input.steps) ? input.steps : [];
  if (raw.length < CHECKLIST_LIMITS.minSteps || raw.length > CHECKLIST_LIMITS.maxSteps) {
    throw new ChecklistInputError(`Give ${CHECKLIST_LIMITS.minSteps} to ${CHECKLIST_LIMITS.maxSteps} steps; split a longer job into two checklists.`);
  }
  const steps = raw.map((s, i) => {
    const o: Record<string, unknown> = s && typeof s === "object" ? (s as Record<string, unknown>) : { do: s };
    const does = clip(o.do, CHECKLIST_LIMITS.step, `step ${i + 1}`);
    if (!does) throw new ChecklistInputError(`Step ${i + 1} needs "do": what to do, in one line.`);
    return { do: does, detail: clip(o.detail, CHECKLIST_LIMITS.detail, `step ${i + 1}'s detail`, true), copy: clip(o.copy, CHECKLIST_LIMITS.copy, `step ${i + 1}'s copy`, true) };
  });
  return { title, why: clip(input.why, CHECKLIST_LIMITS.why, "why"), steps };
}

const all = (companyId: string): Checklist[] => checklistStore.get(companyId).checklists ?? [];

export function getChecklist(companyId: string, id: string): Checklist | null {
  return all(companyId).find((c) => c.id === id) ?? null;
}

/** Checklists still being worked through, oldest first; narrowed to one chat or agent when asked. */
export function openChecklists(companyId: string, where: { threadId?: string; agentTag?: string } = {}): Checklist[] {
  return all(companyId).filter(
    (c) => c.status === "open" && (where.threadId === undefined || c.threadId === where.threadId) && (where.agentTag === undefined || c.agentTag === where.agentTag),
  );
}

/** The checklists each of these turns made (finished ones too: the card shows them done). */
export function checklistsByRun(companyId: string, runIds: Set<string>): Map<string, Checklist[]> {
  const byRun = new Map<string, Checklist[]>();
  for (const c of all(companyId)) {
    if (!c.runId || !runIds.has(c.runId)) continue;
    byRun.set(c.runId, [...(byRun.get(c.runId) ?? []), c]);
  }
  return byRun;
}

export async function createChecklist(
  companyId: string,
  input: ParsedChecklist & { threadId: string; runId: string | null; agentTag: string | null },
  now = new Date(),
): Promise<Checklist> {
  let made: Checklist | null = null;
  let refused: string | null = null;
  await checklistStore.update(companyId, (s) => {
    const list = s.checklists ?? [];
    const open = list.filter((c) => c.status === "open" && c.threadId === input.threadId);
    if (open.some((c) => c.title.toLowerCase() === input.title.toLowerCase())) {
      refused = "That checklist is already with the person. Don't make it again.";
      return s;
    }
    if (open.length >= CHECKLIST_LIMITS.openPerChat) {
      refused = `${open.length} checklists are still open in this chat. Let the person finish one first.`;
      return s;
    }
    made = {
      id: randomUUID(),
      threadId: input.threadId,
      runId: input.runId,
      agentTag: input.agentTag,
      title: input.title,
      why: input.why,
      steps: input.steps.map((step) => ({ id: randomUUID().slice(0, 8), ...step, done: false, doneAt: null })),
      status: "open",
      createdAt: now.toISOString(),
      doneAt: null,
    };
    return { ...s, checklists: [...list, made].slice(-CHECKLIST_LIMITS.kept) };
  });
  if (refused) throw new ChecklistInputError(refused);
  return made!;
}

/** Tick a step on or off. `finished` is true only on the tick that completes the list. */
export async function setChecklistStep(
  companyId: string,
  id: string,
  stepId: string,
  done: boolean,
  now = new Date(),
): Promise<{ checklist: Checklist; finished: boolean }> {
  let result: { checklist: Checklist; finished: boolean } | null = null;
  let refused: string | null = null;
  await checklistStore.update(companyId, (s) => {
    const list = s.checklists ?? [];
    const c = list.find((x) => x.id === id);
    if (!c) {
      refused = "That checklist isn't there any more.";
      return s;
    }
    if (c.status === "dismissed") {
      refused = "That checklist was put away.";
      return s;
    }
    if (!c.steps.some((step) => step.id === stepId)) {
      refused = "That step isn't on the checklist.";
      return s;
    }
    const steps = c.steps.map((step) => (step.id === stepId ? { ...step, done, doneAt: done ? now.toISOString() : null } : step));
    const complete = steps.every((step) => step.done);
    const next: Checklist = { ...c, steps, status: complete ? "done" : "open", doneAt: complete ? (c.doneAt ?? now.toISOString()) : null };
    result = { checklist: next, finished: complete && c.status !== "done" };
    return { ...s, checklists: list.map((x) => (x.id === id ? next : x)) };
  });
  if (refused) throw new ChecklistInputError(refused);
  return result!;
}

/** Put a checklist away unfinished: it leaves Needs you, and its chat is told not to bring it up again. */
export async function dismissChecklist(companyId: string, id: string): Promise<Checklist> {
  let result: Checklist | null = null;
  await checklistStore.update(companyId, (s) => {
    const list = s.checklists ?? [];
    const c = list.find((x) => x.id === id);
    if (!c || c.status !== "open") return s;
    result = { ...c, status: "dismissed" };
    return { ...s, checklists: list.map((x) => (x.id === id ? result! : x)) };
  });
  if (!result) throw new ChecklistInputError("That checklist is already done or put away.");
  return result;
}

/** The note the chat gets when its checklist is put away unfinished. */
export function checklistDismissedNote(c: Checklist): string {
  const done = c.steps.filter((s) => s.done).length;
  return `The person put away the checklist "${c.title}" (${done} of ${c.steps.length} steps ticked). Don't bring it up again unless they do.`;
}

/** The message ticking the last step sends into the chat, as the person's own. */
export function checklistDoneText(c: Checklist): string {
  return `Done: I finished the checklist "${c.title}" (all ${c.steps.length} steps). Check it took if you can, then tell me what's next.`;
}
