import { randomUUID } from "node:crypto";
import { companyStore } from "../company-store.js";

// What tethr did in each connector on its own or with an approval (Mark: "every
// automatic action is recorded"). Kept per company in the instance dir
// (tethr-connector-changes.json). Two uses: the change list on the
// Integrations page, and the month's spending for a connector tethr can't read
// an account for (spend/guard.ts).

export interface ConnectorChange {
  id: string;
  at: string;
  connector: string;
  tool: string;
  summary: string;
  /** The gate's class: write, money, public, destructive. */
  cls: string;
  /** auto = ran on its own; approved = a person said yes on a card. */
  how: "auto" | "approved";
  /** The agent's tag, or @tethr. */
  by: string;
  /** What it commits a month, in the account's currency (money only). */
  amount: number | null;
  /** The call's input hash, so its outcome can be filled in. */
  hash: string | null;
  /** null until the outcome is known. */
  ok: boolean | null;
}

interface ChangesState {
  changes?: ConnectorChange[];
}

const KEPT = 500;
export const changeStore = companyStore<ChangesState>("TETHR_CONNECTOR_CHANGES_FILE", "tethr-connector-changes.json");

export async function recordChange(companyId: string, change: Omit<ConnectorChange, "id" | "at"> & { at?: string }): Promise<ConnectorChange> {
  const entry: ConnectorChange = { id: randomUUID(), at: change.at ?? new Date().toISOString(), ...change };
  await changeStore.update(companyId, (s) => ({ ...s, changes: [...(s.changes ?? []), entry].slice(-KEPT) }));
  return entry;
}

/** Fill in how a logged call came out (the gate hears after it ran). */
export async function recordChangeOutcome(companyId: string, hash: string, ok: boolean): Promise<void> {
  await changeStore.update(companyId, (s) => {
    const list = [...(s.changes ?? [])];
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]!.hash === hash && list[i]!.ok === null) {
        list[i] = { ...list[i]!, ok };
        break;
      }
    }
    return { ...s, changes: list };
  });
}

/** A connector's latest changes, newest first. */
export function recentChanges(companyId: string, connector: string, limit = 20): ConnectorChange[] {
  return (changeStore.get(companyId).changes ?? []).filter((c) => c.connector === connector).slice(-limit).reverse();
}

/** What tethr committed through a connector this calendar month (UTC), failed calls left out. */
export function spentThisMonth(companyId: string, connector: string, now = new Date()): number {
  const month = now.toISOString().slice(0, 7);
  return (changeStore.get(companyId).changes ?? [])
    .filter((c) => c.connector === connector && c.cls === "money" && c.ok !== false && c.at.startsWith(month))
    .reduce((sum, c) => sum + (c.amount ?? 0), 0);
}
