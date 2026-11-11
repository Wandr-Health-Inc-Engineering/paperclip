// Positions on a tethr team (phase 21). tethr helps each person through their
// position's focus: the same question ("what should I do this week?") means
// tech fixes for clients to a CTO and pipeline to a sales lead.

export interface Position {
  key: string;
  title: string;
  /** How tethr helps someone in this seat, in one line (goes into CLAUDE.md). */
  focus: string;
}

export const POSITIONS: Position[] = [
  { key: "founder", title: "Founder / CEO", focus: "priorities, revenue and the big bets; what moves the whole business" },
  { key: "coo", title: "COO / Operations", focus: "running the business: process, follow-through, and keeping the team on pace" },
  { key: "cto", title: "CTO / Engineering", focus: "tech fixes and improvements that give clients a better experience" },
  { key: "growth", title: "Growth / Marketing", focus: "getting and keeping customers: channels, content, campaigns, conversion" },
  { key: "sales", title: "Sales / Partnerships", focus: "pipeline, deals and partners: who to talk to next and what to say" },
  { key: "product", title: "Product", focus: "what to build next, from what customers say and do" },
  { key: "other", title: "Other", focus: "their own area; ask what matters most to them" },
];

export function positionOf(key: string | null | undefined): Position {
  return POSITIONS.find((p) => p.key === key) ?? POSITIONS[POSITIONS.length - 1];
}
