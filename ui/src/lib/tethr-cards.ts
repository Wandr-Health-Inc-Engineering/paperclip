// Pure helpers for the cards that wait on a person (approvals, questions,
// connections): what each one asks, in plain words, and what an agent card's
// details say. Used by the chat, the Needs you page and the bell, so all three
// read the same.

export interface CardOutput {
  kind: string;
  status: string;
  sensitivity: string;
  title: string;
  body: string;
  meta?: Record<string, unknown> | null;
}

export function kindLabel(kind: string): string {
  if (kind === "team_agent") return "New agent";
  if (kind === "team_change") return "Agent change";
  const k = kind.replace(/_/g, " ");
  return k.charAt(0).toUpperCase() + k.slice(1);
}

/** A plain-text taste of a body: front matter and Markdown marks stripped. */
export function previewText(body: string): string {
  return body
    .replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, "")
    .replace(/[#>*_`|[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 320);
}

/** Why a card always asks, said the way a person would: only for the kinds that need saying. */
const WHY_IT_ASKS: Record<string, string> = {
  spend: "spends money",
  public: "goes outside the company",
  medical: "medical",
  destructive: "deletes or overwrites",
  pr: "public relations",
};

/** What a waiting card wants, in plain words: "Needs your approval: new agent". */
export function cardHeading(output: Pick<CardOutput, "kind" | "status" | "sensitivity" | "meta">): string {
  const lead = output.status === "changes_requested" ? "Changes requested" : "Needs your approval";
  const why = WHY_IT_ASKS[output.sensitivity];
  const what =
    output.kind === "external_action"
      ? `${String(output.meta?.connector ?? "an")} action`
      : output.kind === "team_agent"
        ? "new agent"
        : output.kind === "team_change"
          ? "change to an agent"
          : kindLabel(output.kind).toLowerCase();
  return `${lead}: ${what}${why ? ` · ${why}` : ""}`;
}

/** After a decision: what happened to a team card, or null while it still waits. */
export function decidedLine(output: Pick<CardOutput, "kind" | "status" | "meta">): { tone: "ok" | "bad"; label: string } | null {
  if (output.status === "gated" || output.status === "changes_requested") return null;
  const applyError = typeof output.meta?.applyError === "string" ? output.meta.applyError : null;
  if (applyError) return { tone: "bad", label: `Couldn't be applied: ${applyError}` };
  if (output.status === "rejected") return { tone: "bad", label: "Rejected" };
  if (output.kind === "team_agent") return { tone: "ok", label: "Approved: it's on the team" };
  return { tone: "ok", label: "Approved" };
}

export interface CardDetails {
  /** "Mission: …" lines at the top of the body, as label and value. */
  rows: Array<[string, string]>;
  /** The longer parts under them ("Instructions:", "First task: …", "Why: …"). */
  blocks: Array<{ heading: string; text: string }>;
}

const LABELLED = /^([A-Z][^:]{1,40}):\s*(.*)$/;

/**
 * An agent card's body, read back into its parts. The server writes it as
 * labelled lines, then blocks separated by blank lines (team-spec.ts
 * teamSpecText). Returns null when the body isn't shaped that way (the caller
 * then shows it whole).
 */
export function cardDetails(body: string): CardDetails | null {
  const [head, ...rest] = body.replace(/\r\n/g, "\n").trim().split(/\n\s*\n/);
  // The first line names the agent, which the card's title already says.
  const rows = (head ?? "")
    .split("\n")
    .slice(1)
    .map((line) => LABELLED.exec(line.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => [m[1]!, m[2]!] as [string, string]);
  if (rows.length < 3) return null;
  const blocks = rest
    .map((block) => {
      const [first, ...lines] = block.split("\n");
      const m = LABELLED.exec((first ?? "").trim());
      if (!m) return { heading: "", text: block.trim() };
      // "Instructions:" heads the lines under it; "First task: Audit…" carries its title on the same line.
      return { heading: m[1]!, text: [m[2], ...lines].filter(Boolean).join("\n").trim() };
    })
    .filter((b) => b.text);
  return { rows, blocks };
}
