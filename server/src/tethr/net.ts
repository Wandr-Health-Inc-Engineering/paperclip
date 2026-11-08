import dns from "node:dns/promises";

// Which hosts tethr may fetch from. tethr's own API answers loopback requests
// as the board admin (local_trusted), so any fetch that reaches this machine or
// its network could read private data. Shared by the chat's approval gate and
// the classic engine's web tools.

/** This machine or a private network: localhost names, loopback, private,
 * link-local and CGNAT/Tailscale ranges, IPv6 loopback/ULA/link-local. */
export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!h) return true;
  if (h === "localhost" || /\.(localhost|local|internal|lan|home\.arpa)$/.test(h)) return true;
  if (h.includes(":")) {
    return h === "::" || h === "::1" || /^(fe8|fe9|fea|feb|fc|fd)/.test(h) || h.startsWith("::ffff:");
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

export type HostLookup = (host: string) => Promise<Array<{ address: string }>>;

const systemLookup: HostLookup = (host) => dns.lookup(host, { all: true, verbatim: true });

/** Does a web host's name resolve to this machine or a private network? The
 * name check above can't see that (127.0.0.1.nip.io, a LAN name), so callers
 * look the name up before fetching. A lookup that fails or times out isn't a
 * private address (the fetch would fail on its own). */
export async function resolvesToPrivateHost(host: string, lookup: HostLookup = systemLookup, timeoutMs = 2_000): Promise<boolean> {
  if (!host || isPrivateHost(host)) return true;
  if (/^[\d.]+$/.test(host) || host.includes(":")) return false; // a literal address: already judged
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addrs = await Promise.race([
      lookup(host),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
    return addrs.some((a) => isPrivateHost(a.address));
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const MAX_REDIRECTS = 5;

/** GET a public http(s) URL. Every hop, redirects included, is checked against
 * this machine and its network before it's requested, so a public page can't
 * bounce the request to localhost. (A name that resolves differently between
 * the check and the request can still slip through; that needs control of the
 * name's DNS and is out of reach for a pasted link.) */
export async function fetchPublic(url: string, init: { headers: Record<string, string>; timeoutMs: number }, lookup: HostLookup = systemLookup): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const target = new URL(current);
    if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error(`refused ${target.protocol} URL`);
    if (await resolvesToPrivateHost(target.hostname.replace(/^\[|\]$/g, ""), lookup)) {
      throw new Error(`refused ${target.hostname}: it's this computer or its local network`);
    }
    const res = await fetch(target, { headers: init.headers, signal: AbortSignal.timeout(init.timeoutMs), redirect: "manual" });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return res;
    await res.body?.cancel().catch(() => {});
    current = new URL(location, target).toString();
  }
  throw new Error(`too many redirects from ${url}`);
}
