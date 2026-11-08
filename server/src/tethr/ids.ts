import crypto from "node:crypto";

/**
 * A stable UUID (v4-shaped) for a named thing in a company, e.g. its
 * "Operations" or "Ideas" side chat: the same company always gets the same id,
 * so there's nothing to store.
 */
export function stableThreadId(name: string, companyId: string): string {
  const hash = crypto.createHash("sha256").update(`tethr-${name}:${companyId}`).digest("hex");
  const variant = ((parseInt(hash[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
