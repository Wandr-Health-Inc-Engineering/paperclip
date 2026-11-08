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

/** Write a NEW file in `dir`: `name`, or "stem (2).ext", "stem (3).ext"… if
 * taken. The name is claimed with an exclusive create first, so two writers
 * racing for the same name each get their own file; the contents then land
 * through writeAtomic. Returns the name used. `allow` can veto a candidate. */
export async function writeNewFile(
  dir: string,
  name: string,
  data: string | Buffer,
  allow: (absPath: string) => boolean = () => true,
): Promise<string> {
  await fsp.mkdir(dir, { recursive: true });
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let n = 1; n <= 500; n++) {
    const candidate = n === 1 ? name : `${stem} (${n})${ext}`;
    const abs = path.join(dir, candidate);
    if (!allow(abs)) throw new Error(`${candidate} isn't an allowed file name.`);
    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(abs, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
    await handle.close();
    try {
      await writeAtomic(abs, data);
    } catch (err) {
      await fsp.unlink(abs).catch(() => {});
      throw err;
    }
    return candidate;
  }
  throw new Error(`Too many files called ${name} already.`);
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
