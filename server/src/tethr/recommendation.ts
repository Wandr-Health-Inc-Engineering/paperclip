// Standard agent-recommendation message format (Phase 2).
//
// One typed builder for the recommendation an agent posts to #scout: what's
// wrong, why it matters, the affected URL/page/file, the agent codename, and a
// footer telling the human to reply in-thread and tag @Cursor. Block Kit,
// plain black/white — no emoji, no color. File paths are emitted as plain text
// so they survive copy/paste into an @Cursor instruction unmangled.

export type RecommendationSeverity = "high" | "medium" | "low";

export interface RecommendationInput {
  /** Agent codename, e.g. "Sentry". */
  agentCodename: string;
  /** The headline: what's wrong. */
  title: string;
  /** Why it matters (impact), one or two sentences. */
  why: string;
  /** Public URL the finding is about, if determinable. */
  affectedUrl?: string;
  /** Human-facing page/path, e.g. "/destinations/peru". */
  affectedPage?: string;
  /** Likely repo file path — PLAIN TEXT, must survive copy for @Cursor. */
  filePath?: string;
  /** Highest first when a batch is posted. */
  severity?: RecommendationSeverity;
  /** Optional extra lines (concrete numbers/specifics). */
  details?: string[];
}

export interface BuiltRecommendation {
  /** Single-line fallback / notification text (also Slack `text` for a11y). */
  text: string;
  /** Multi-line plain-text body (in-app center, SMS/email fallback). */
  body: string;
  /** Slack Block Kit blocks. */
  blocks: Array<Record<string, unknown>>;
}

const FOOTER = "Reply in-thread and tag @Cursor to fix.";

function severityLabel(sev?: RecommendationSeverity): string {
  return (sev ?? "medium").toUpperCase();
}

/** Plain-text affected lines (no markdown that could break an @Cursor copy). */
function affectedLines(input: RecommendationInput): string[] {
  const lines: string[] = [];
  if (input.affectedUrl) lines.push(`URL: ${input.affectedUrl}`);
  if (input.affectedPage) lines.push(`Page: ${input.affectedPage}`);
  if (input.filePath) lines.push(`File: ${input.filePath}`);
  return lines;
}

export function buildRecommendation(input: RecommendationInput): BuiltRecommendation {
  const sev = severityLabel(input.severity);
  const affected = affectedLines(input);
  const details = (input.details ?? []).filter((d) => d.trim().length > 0);

  // ---- Slack Block Kit (mrkdwn; no emoji/color) ----
  const blocks: Array<Record<string, unknown>> = [
    { type: "section", text: { type: "mrkdwn", text: `*${input.title}*` } },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `${sev} · ${input.agentCodename}` }],
    },
    { type: "section", text: { type: "mrkdwn", text: `*Why it matters*\n${input.why}` } },
  ];
  if (affected.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Affected*\n${affected.join("\n")}` },
    });
  }
  if (details.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: details.map((d) => `• ${d}`).join("\n") },
    });
  }
  blocks.push({ type: "divider" });
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: FOOTER }] });

  // ---- Plain-text body (in-app / SMS / email / fallback) ----
  const bodyParts = [
    `[${sev}] ${input.title}`,
    "",
    `Why it matters: ${input.why}`,
  ];
  if (affected.length > 0) bodyParts.push("", ...affected);
  if (details.length > 0) bodyParts.push("", ...details.map((d) => `- ${d}`));
  bodyParts.push("", FOOTER);
  const body = bodyParts.join("\n");

  const text = `[${sev}] ${input.title} — ${input.agentCodename}`;

  return { text, body, blocks };
}
