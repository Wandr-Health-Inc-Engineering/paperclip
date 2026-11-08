import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, tethrMembers } from "@paperclipai/db";
import { goalsService, oneLine } from "./goals.js";
import { companyGoalTitle, TETHR_MISSION } from "./mission.js";
import { POSITIONS, positionOf } from "./positions.js";

// The company behind a tethr workspace (phase 21): its name, what it sells, and
// the team (an admin now; invited members later). tethr is built to be sold, so
// none of this is hard-coded: the chat reads it every turn (companyContextText →
// the workspace CLAUDE.md) and the setup's first step writes it.

export type MemberRow = typeof tethrMembers.$inferSelect;

export interface CompanyProfile {
  id: string;
  name: string;
  /** What the company sells, in a line (core companies.description). */
  sells: string;
  prefix: string;
  mission: string;
  admin: MemberRow | null;
  members: MemberRow[];
}

export class CompanyInputError extends Error {}

const SLACK_ID = /^[UW][A-Z0-9]{6,20}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface CompanyStepInput {
  companyName?: unknown;
  sells?: unknown;
  adminName?: unknown;
  adminEmail?: unknown;
  position?: unknown;
  positionTitle?: unknown;
  slackUserId?: unknown;
}

export function companyProfileService(db: Db) {
  async function get(companyId: string): Promise<CompanyProfile | null> {
    const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
    if (!company) return null;
    const members = await db
      .select()
      .from(tethrMembers)
      .where(eq(tethrMembers.companyId, companyId))
      .orderBy(asc(tethrMembers.createdAt));
    return {
      id: company.id,
      name: company.name,
      sells: company.description ?? "",
      prefix: company.issuePrefix,
      mission: TETHR_MISSION,
      admin: members.find((m) => m.role === "admin") ?? null,
      members,
    };
  }

  return {
    get,

    /** Setup step 1: the company, and you as its admin. Returns the new profile. */
    async saveCompanyStep(companyId: string, input: CompanyStepInput): Promise<CompanyProfile> {
      const name = oneLine(input.companyName, 80);
      if (!name) throw new CompanyInputError("Give the company a name.");
      const sells = oneLine(input.sells, 240);
      const adminName = oneLine(input.adminName, 80);
      if (!adminName) throw new CompanyInputError("Add your name.");
      const email = oneLine(input.adminEmail, 160).toLowerCase();
      if (email && !EMAIL.test(email)) throw new CompanyInputError("That email doesn't look right.");
      const positionKey = typeof input.position === "string" && POSITIONS.some((p) => p.key === input.position) ? input.position : null;
      if (!positionKey) throw new CompanyInputError("Pick your position.");
      const customTitle = oneLine(input.positionTitle, 60);
      if (positionKey === "other" && !customTitle) throw new CompanyInputError("Say what your position is.");
      const title = customTitle || positionOf(positionKey).title;
      const slack = oneLine(input.slackUserId, 24).toUpperCase();
      if (slack && !SLACK_ID.test(slack)) throw new CompanyInputError("A Slack member ID looks like U0123ABCD (Profile → ⋯ → Copy member ID).");

      const now = new Date();
      await db.update(companies).set({ name, description: sells || null, updatedAt: now }).where(eq(companies.id, companyId));
      const [admin] = await db
        .select()
        .from(tethrMembers)
        .where(and(eq(tethrMembers.companyId, companyId), eq(tethrMembers.role, "admin")))
        .limit(1);
      const fields = { name: adminName, email: email || null, position: positionKey, title, slackUserId: slack || null, status: "active", updatedAt: now };
      if (admin) await db.update(tethrMembers).set(fields).where(eq(tethrMembers.id, admin.id));
      else await db.insert(tethrMembers).values({ companyId, role: "admin", ...fields });

      // The root goal everything hangs under follows the company's name; the
      // mission itself is built in.
      await goalsService(db).saveGoal(companyId, { level: "company", title: companyGoalTitle(name), description: TETHR_MISSION });
      return (await get(companyId))!;
    },

    /** Slack member ids of the company's admins (they may approve from Slack). */
    async adminSlackIds(companyId: string): Promise<Array<{ slackId: string; name: string }>> {
      const rows = await db
        .select({ slackUserId: tethrMembers.slackUserId, name: tethrMembers.name })
        .from(tethrMembers)
        .where(and(eq(tethrMembers.companyId, companyId), eq(tethrMembers.role, "admin")));
      return rows.filter((r) => r.slackUserId).map((r) => ({ slackId: r.slackUserId!, name: r.name }));
    },
  };
}

/** The first name the chat and the approval cards use for the admin. */
export function adminFirstName(profile: CompanyProfile | null): string | null {
  const name = profile?.admin?.name?.trim();
  return name ? name.split(/\s+/)[0] : null;
}

/** "## The company" and "## Your team" for the chat's CLAUDE.md, every turn. */
export function companyContextText(profile: CompanyProfile | null): string {
  if (!profile || !profile.admin) {
    return [
      "## The company",
      `- What tethr is for: ${TETHR_MISSION}`,
      "- The company profile isn't set up yet. If someone asks for plans or priorities, suggest finishing tethr's setup first (Set up tethr).",
    ].join("\n");
  }
  const lines = [
    "## The company",
    `- Name: ${oneLine(profile.name, 80)}`,
    ...(profile.sells ? [`- What it sells: ${oneLine(profile.sells, 240)}`] : []),
    `- What tethr is for: ${TETHR_MISSION}`,
    "",
    "## Your team",
  ];
  for (const m of profile.members.filter((x) => x.status === "active")) {
    const focus = positionOf(m.position).focus;
    lines.push(`- ${oneLine(m.name, 80)}: ${oneLine(m.title, 60)}${m.role === "admin" ? " (admin)" : ""}. Help them through ${focus}.`);
  }
  const first = adminFirstName(profile);
  lines.push(
    `You're talking with ${first} in this chat unless a message says otherwise. Help each person through their position's focus, and keep the team small: do the work, don't add busywork.`,
  );
  return lines.join("\n");
}
