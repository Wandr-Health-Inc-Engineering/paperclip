import { randomUUID } from "node:crypto";
import { companyStore } from "../company-store.js";
import { oneLine } from "../goals.js";

// Phase 27: questions tethr and its agents put to a person as a card with
// buttons, instead of asking in prose and waiting ("want me to save these as
// they are?"). A question grants nothing by itself: answering it sends the
// answer into the chat it was asked in, as the person's own message, and the
// next turn acts on it. Anything outward still gets its own approval card.
//
// Kept per company in the instance dir (tethr-questions.json), like the other
// small stores. Answered ones stay so the card can show how it was answered.

export const QUESTION_LIMITS = {
  question: 200,
  detail: 1_200,
  minOptions: 2,
  maxOptions: 4,
  optionLabel: 40,
  optionDescription: 140,
  comment: 2_000,
  /** At most this many unanswered questions in one chat: a wall of cards is no clearer than a wall of text. */
  openPerChat: 3,
  kept: 300,
};

export interface QuestionOption {
  label: string;
  description: string | null;
}

export interface QuestionAnswer {
  /** "approve" or "reject" on a yes/no card, an option's label on a choice card, null for a comment alone. */
  choice: string | null;
  comment: string | null;
  by: string;
  at: string;
  /** Answered on the card, or by writing in the chat instead. */
  via: "card" | "chat";
}

export interface Question {
  id: string;
  threadId: string;
  /** The turn that asked (the card shows under it). */
  runId: string | null;
  /** The agent that asked, or null for tethr itself. */
  agentTag: string | null;
  question: string;
  detail: string | null;
  /** null = Approve / Reject. */
  options: QuestionOption[] | null;
  /** Set on a connection card: what's missing. Its answers are "connected" and "without". */
  connection?: { key: string };
  status: "open" | "answered";
  answer: QuestionAnswer | null;
  askedAt: string;
}

/** A connection card's two answers: it's connected now, or carry on without it. */
export const CONNECTION_ANSWERS = ["connected", "without"] as const;

interface QuestionsState {
  questions?: Question[];
}

export const questionStore = companyStore<QuestionsState>("TETHR_QUESTIONS_FILE", "tethr-questions.json");

export class QuestionInputError extends Error {}

export interface ParsedAsk {
  question: string;
  detail: string | null;
  options: QuestionOption[] | null;
}

/** Check and tidy what the tool was given. Throws QuestionInputError with a plain message. */
export function parseAsk(input: Record<string, unknown>): ParsedAsk {
  const question = oneLine(input.question, QUESTION_LIMITS.question + 1);
  if (!question) throw new QuestionInputError("Give the question, in one line.");
  if (question.length > QUESTION_LIMITS.question) throw new QuestionInputError(`Keep the question to one line of at most ${QUESTION_LIMITS.question} characters; put the rest in detail.`);
  const detail = typeof input.detail === "string" ? input.detail.replace(/\r\n/g, "\n").trim() : "";
  if (detail.length > QUESTION_LIMITS.detail) throw new QuestionInputError(`Keep the detail under ${QUESTION_LIMITS.detail} characters.`);
  let options: QuestionOption[] | null = null;
  if (input.options !== undefined && input.options !== null) {
    if (!Array.isArray(input.options)) throw new QuestionInputError("options is a list of { label, description }.");
    options = input.options.map((raw) => {
      const o: Record<string, unknown> = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : { label: raw };
      const label = oneLine(o.label, QUESTION_LIMITS.optionLabel + 1);
      if (!label) throw new QuestionInputError("Every option needs a label.");
      if (label.length > QUESTION_LIMITS.optionLabel) throw new QuestionInputError(`Keep each option's label to ${QUESTION_LIMITS.optionLabel} characters (it's a button).`);
      return { label, description: oneLine(o.description, QUESTION_LIMITS.optionDescription) || null };
    });
    if (options.length < QUESTION_LIMITS.minOptions || options.length > QUESTION_LIMITS.maxOptions) {
      throw new QuestionInputError(`Give ${QUESTION_LIMITS.minOptions} to ${QUESTION_LIMITS.maxOptions} options, or none for a yes/no.`);
    }
    if (new Set(options.map((o) => o.label.toLowerCase())).size !== options.length) throw new QuestionInputError("Two options have the same label.");
  }
  return { question, detail: detail || null, options };
}

const all = (companyId: string): Question[] => questionStore.get(companyId).questions ?? [];

export function getQuestion(companyId: string, id: string): Question | null {
  return all(companyId).find((q) => q.id === id) ?? null;
}

/** Unanswered questions, oldest first; narrowed to one chat or one agent when asked. */
export function openQuestions(companyId: string, where: { threadId?: string; agentTag?: string } = {}): Question[] {
  return all(companyId).filter(
    (q) => q.status === "open" && (where.threadId === undefined || q.threadId === where.threadId) && (where.agentTag === undefined || q.agentTag === where.agentTag),
  );
}

/** The questions asked by each of these turns (answered ones too: the card shows the answer). */
export function questionsByRun(companyId: string, runIds: Set<string>): Map<string, Question[]> {
  const byRun = new Map<string, Question[]>();
  for (const q of all(companyId)) {
    if (!q.runId || !runIds.has(q.runId)) continue;
    byRun.set(q.runId, [...(byRun.get(q.runId) ?? []), q]);
  }
  return byRun;
}

/** Record a question. Throws when the chat already has too many unanswered, or this one is already open. */
export async function askQuestion(
  companyId: string,
  ask: ParsedAsk & { threadId: string; runId: string | null; agentTag: string | null; connection?: { key: string } },
  now = new Date(),
): Promise<Question> {
  let made: Question | null = null;
  let refused: string | null = null;
  await questionStore.update(companyId, (s) => {
    const questions = s.questions ?? [];
    const open = questions.filter((q) => q.status === "open" && q.threadId === ask.threadId);
    if (open.some((q) => q.question.toLowerCase() === ask.question.toLowerCase())) {
      refused = "That question is already waiting on the person. Don't ask it again; go on with what you can.";
      return s;
    }
    // A missing connection is a fact, not a choice: its card doesn't count toward the limit.
    const asked = open.filter((q) => !q.connection);
    if (!ask.connection && asked.length >= QUESTION_LIMITS.openPerChat) {
      refused = `${asked.length} questions are already waiting on the person in this chat. Wait for an answer before asking more.`;
      return s;
    }
    made = {
      id: randomUUID(),
      threadId: ask.threadId,
      runId: ask.runId,
      agentTag: ask.agentTag,
      question: ask.question,
      detail: ask.detail,
      options: ask.options,
      ...(ask.connection ? { connection: ask.connection } : {}),
      status: "open",
      answer: null,
      askedAt: now.toISOString(),
    };
    return { ...s, questions: [...questions, made].slice(-QUESTION_LIMITS.kept) };
  });
  if (refused) throw new QuestionInputError(refused);
  return made!;
}

/** Whether a choice fits the card: Approve/Reject on a yes/no, one of the labels on a choice card. */
function validChoice(q: Question, choice: string): boolean {
  if (q.connection) return (CONNECTION_ANSWERS as readonly string[]).includes(choice);
  return q.options ? q.options.some((o) => o.label === choice) : choice === "approve" || choice === "reject";
}

/** Answer an open question. Throws QuestionInputError when it isn't open or the answer doesn't fit. */
export async function answerQuestion(
  companyId: string,
  id: string,
  input: { choice?: unknown; comment?: unknown; by: string },
  now = new Date(),
): Promise<Question> {
  const choice = typeof input.choice === "string" && input.choice.trim() ? input.choice.trim() : null;
  const comment = typeof input.comment === "string" ? input.comment.replace(/\r\n/g, "\n").trim().slice(0, QUESTION_LIMITS.comment) : "";
  if (!choice && !comment) throw new QuestionInputError("Pick an answer or write a comment.");
  let answered: Question | null = null;
  let refused: string | null = null;
  await questionStore.update(companyId, (s) => {
    const questions = s.questions ?? [];
    const q = questions.find((x) => x.id === id);
    if (!q) refused = "That question isn't there any more.";
    else if (q.status !== "open") refused = "That question was already answered.";
    else if (choice && !validChoice(q, choice)) refused = "That isn't one of this question's answers.";
    if (refused || !q) return s;
    answered = { ...q, status: "answered", answer: { choice, comment: comment || null, by: input.by, at: now.toISOString(), via: "card" } };
    return { ...s, questions: questions.map((x) => (x.id === id ? answered! : x)) };
  });
  if (refused) throw new QuestionInputError(refused);
  return answered!;
}

/** The person wrote in the chat instead of using a card: that's their answer to what was open there.
 * A connection card stays: it's a fact to fix, and typing doesn't connect anything. */
export async function closeQuestionsAnsweredInChat(companyId: string, threadId: string, by: string, now = new Date()): Promise<number> {
  if (!openQuestions(companyId, { threadId }).some((q) => !q.connection)) return 0;
  let closed = 0;
  await questionStore.update(companyId, (s) => ({
    ...s,
    questions: (s.questions ?? []).map((q) => {
      if (q.status !== "open" || q.threadId !== threadId || q.connection) return q;
      closed += 1;
      return { ...q, status: "answered" as const, answer: { choice: null, comment: null, by, at: now.toISOString(), via: "chat" as const } };
    }),
  }));
  return closed;
}

/** The message an answer becomes in the chat: the person's own words to whoever asked. */
export function answerText(q: Question): string {
  const a = q.answer;
  if (!a) return "";
  const about = `"${q.question}"`;
  const comment = a.comment ? `\n${a.comment}` : "";
  if (q.connection && a.choice === "connected") return `Connected: ${q.connection.key}. Check that it answers, then carry on.${comment}`;
  if (q.connection && a.choice === "without") return `Carry on without ${q.connection.key}. Don't ask for it again; do what you can and say what you couldn't.${comment}`;
  if (a.choice === "approve" && !q.options) return `Approved: ${about}${comment}`;
  if (a.choice === "reject" && !q.options) return `Rejected: ${about}${comment}`;
  if (a.choice) return `About ${about}: ${a.choice}${comment}`;
  return `About ${about}: ${a.comment ?? ""}`;
}

/** How a card's buttons read, for the tool's result. */
export function buttonsOf(q: Pick<Question, "options" | "connection">): string {
  if (q.connection) return `the fix in place, "I've connected it" and "Carry on without it"`;
  return q.options ? `${q.options.map((o) => `"${o.label}"`).join(", ")} and Comment` : "Approve, Reject and Comment";
}
