import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

// Small file-safety helpers shared by Tethr's instance-dir JSON stores and the
// Drive-synced files it writes.

/** Same-dir dot-temp + atomic rename. The temp name is random, so concurrent
 * writers never share one; a reader never sees a half-written file; Drive sync
 * never uploads a partial file at the final name. */
export async function writeAtomic(absPath: string, data: string | Buffer): Promise<void> {
  const dir = path.dirname(absPath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.tethr-${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, absPath);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

const chains = new Map<string, Promise<unknown>>();

/** Run `fn` after every earlier call with the same key has settled (one
 * process-wide queue per key). Use it around read-modify-write of a JSON file
 * so concurrent updates never drop each other's changes. */
export function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, settled);
  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });
  return next;
}
