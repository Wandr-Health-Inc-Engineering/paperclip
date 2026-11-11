// What tethr is for (phase 21): built in, not typed during setup. tethr is a
// product: an operational workflow tool that tethers a small team together and
// gives every member a real AI partner to go to market. Each company brings its
// own name, what it sells and its goals; the mission is the same everywhere.

export const TETHR_MISSION =
  "tethr keeps a small team tethered together and gives every member a real AI partner to take the business to market: real work toward real numbers, not noise, so the team can stay small and still grow.";

/** The root goal every company's goals hang under (kept in sync with its name). */
export function companyGoalTitle(companyName: string): string {
  const name = companyName.trim() || "The company";
  return `${name}: grow with a small team`;
}
