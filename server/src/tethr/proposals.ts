import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, tethrAgentProfiles } from "@paperclipai/db";
import type { TethrAgentSpec } from "@paperclipai/shared";
import { getTethrLLMProvider } from "./llm/index.js";
import { gatingService } from "./gating.js";
import {
  MAX_PROPOSAL_BUDGET_CENTS,
  PROPOSABLE_TOOLS,
  validateAgentSpec,
} from "./factory.js";

// The CEO's "propose a new agent" capability. It drafts a spec (LLM), validates
// it against what we can actually build, and stages it as a gated `agent_proposal`
// output — which lands in the Queue and pings Slack. A human's approval is what
// turns it into a real agent (see gating.approveAgentProposal).

export class NoCeoError extends Error {
  constructor() {
    super("No CEO agent in this company — seed the CEO first.");
    this.name = "NoCeoError";
  }
}

export class ProposalRejectedError extends Error {
  constructor(public errors: string[]) {
    super(`The proposed spec didn't pass validation: ${errors.join("; ")}`);
    this.name = "ProposalRejectedError";
  }
}

function renderProposalBody(spec: TethrAgentSpec): string {
  const cadence = spec.heartbeatCron
    ? `${spec.heartbeatNote ?? spec.heartbeatCron} — seeded paused`
    : "on request";
  return [
    `## Proposed agent: ${spec.codename} — ${spec.role}`,
    "",
    spec.mission,
    "",
    `**Why:** ${spec.rationale}`,
    "",
    `**Tools:** ${spec.tools.join(", ") || "(baseline only)"}`,
    `**Budget:** $${(spec.budgetMonthlyCents / 100).toFixed(0)}/mo (hard cap)`,
    `**Cadence:** ${cadence}`,
    "",
    "**Subagents:**",
    ...spec.subagents.map((s) => `- **${s.name}** (@${spec.codename.toLowerCase().replace(/[^a-z0-9]/g, "")}.${s.key}): ${s.job}`),
    "",
    "_Approve to create this agent (it starts paused, reporting to the CEO). Reject to discard._",
  ].join("\n");
}

export interface ProposeAgentOptions {
  /** What to propose an agent for. Defaults to an open-ended prompt. */
  brief?: string;
  /** Marks a proposal the CEO generated on its own heartbeat (vs on request). */
  autonomous?: boolean;
}

/** Draft, validate, and stage a new-agent proposal for human approval. */
export async function proposeAgent(
  db: Db,
  companyId: string,
  opts: ProposeAgentOptions = {},
) {
  const [ceo] = await db
    .select()
    .from(tethrAgentProfiles)
    .where(and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, "@ceo")))
    .limit(1);
  if (!ceo) throw new NoCeoError();

  const [company] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  const existing = await db
    .select({ tag: tethrAgentProfiles.tag, codename: tethrAgentProfiles.codename })
    .from(tethrAgentProfiles)
    .where(eq(tethrAgentProfiles.companyId, companyId));
  const existingTags = new Set(existing.map((e) => e.tag));

  const provider = getTethrLLMProvider();
  const { spec: rawSpec } = await provider.proposeAgent({
    companyMission: company?.description ?? ceo.mission ?? "Wandr's marketing & distribution.",
    brief: opts.brief?.trim() || "a high-value area we're not covering yet",
    availableTools: [...PROPOSABLE_TOOLS],
    existingAgents: existing.map((e) => e.codename),
    maxBudgetCents: MAX_PROPOSAL_BUDGET_CENTS,
  });

  const validation = validateAgentSpec(rawSpec, { existingTags });
  if (!validation.ok || !validation.spec) {
    throw new ProposalRejectedError(validation.errors);
  }
  const spec = validation.spec;

  const gating = gatingService(db);
  const output = await gating.createOutput({
    companyId,
    agentId: ceo.agentId,
    agentTag: "@ceo",
    kind: "agent_proposal",
    title: `New agent: ${spec.codename} — ${spec.role}`,
    body: renderProposalBody(spec),
    sensitivity: "org", // gated → Queue + Slack, needs a human yes/no
    meta: { spec, autonomous: opts.autonomous === true },
  });

  return { output, spec };
}
