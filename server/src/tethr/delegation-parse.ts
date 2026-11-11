// Phase 16a — recognizing an explicit hand-off in plain text. Pure (no I/O) so
// both the router and the offline mock can use it.

/**
 * Parse an explicit hand-off:
 * "delegate keyword research to @rank and a GEO audit of /malaria to @tank"
 * → [{ to: "@rank", title: "Keyword research" }, { to: "@tank", title: "A GEO audit of /malaria" }].
 * Used by the router (an explicit hand-off goes to the delegator) and by the
 * offline mock (deterministic delegate_task calls). Live Claude still decides
 * the actual delegate_task calls itself.
 */
export function parseDelegations(prompt: string): Array<{ to: string; title: string }> {
  const m = prompt.match(/\b(?:delegate|assign|hand off|split)\b([\s\S]*)/i);
  if (!m) return [];
  const out: Array<{ to: string; title: string }> = [];
  const seen = new Set<string>();
  for (const x of m[1]!.matchAll(/([^,;:\n]+?)\s+to\s+(@[a-z][\w-]*)/gi)) {
    const title = x[1]!.replace(/^\s*(?:and|then|also)\s+/i, "").replace(/^\s*(?:the\s+)?/i, "").trim();
    const to = x[2]!.toLowerCase();
    const key = `${to}|${title.toLowerCase()}`;
    if (!title || seen.has(key)) continue;
    seen.add(key);
    out.push({ to, title: title.charAt(0).toUpperCase() + title.slice(1) });
    if (out.length >= 6) break;
  }
  return out;
}
