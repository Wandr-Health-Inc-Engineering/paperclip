import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { serialize, writeAtomic } from "./atomic.js";

// A per-company JSON record in the instance dir (phase 26): the same pattern as
// tethr-memory.json and tethr-growth-map.json, in one place. Reads are plain
// file reads; every write is a serialized read-modify-write with an atomic
// write. Tests set the env var; a test that doesn't never touches the instance.

export interface CompanyStore<T extends object> {
  file(): string;
  get(companyId: string): T;
  update(companyId: string, fn: (s: T) => T): Promise<T>;
}

export function companyStore<T extends object>(envVar: string, fileName: string): CompanyStore<T> {
  const file = () => {
    if (process.env[envVar]) return process.env[envVar]!;
    if (process.env.VITEST) return path.join(os.tmpdir(), `${fileName.replace(/\.json$/, "")}-test-${process.pid}.json`);
    return path.resolve(resolvePaperclipInstanceRoot(), fileName);
  };
  const read = (): Record<string, T> => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file(), "utf8"));
      return parsed && typeof parsed === "object" ? (parsed as Record<string, T>) : {};
    } catch {
      return {};
    }
  };
  return {
    file,
    get: (companyId) => read()[companyId] ?? ({} as T),
    update: (companyId, fn) =>
      serialize(file(), async () => {
        const data = read();
        const next = fn({ ...(data[companyId] ?? ({} as T)) });
        data[companyId] = next;
        await writeAtomic(file(), JSON.stringify(data, null, 2));
        return next;
      }),
  };
}
