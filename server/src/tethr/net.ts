import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import type { Readable } from "node:stream";
import zlib from "node:zlib";

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
 * name check above can't see that (127.0.0.1.nip.io, a LAN name), so the chat's
 * gate looks the name up before allowing a fetch. A lookup that fails or times
 * out isn't a private address (the fetch would fail on its own). */
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

export interface PublicResponse {
  ok: boolean;
  status: number;
  headers: http.IncomingHttpHeaders;
  text(): Promise<string>;
}

export interface FetchPublicOptions {
  headers: Record<string, string>;
  /** For the whole fetch, redirects included. */
  timeoutMs: number;
  /** Tests: resolve names without DNS. */
  lookup?: HostLookup;
  /** Tests: which resolved addresses are refused (default: this computer and its network). */
  isRefusedAddress?: (address: string) => boolean;
}

const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const LOCAL_NETWORK = "it's this computer or its local network";
const TOO_LARGE = "the page is too large to read";

/** GET a public http(s) URL. Every hop, redirects included, is checked against
 * this machine and its network: an address literal before the request, a name
 * at connect time, on the very addresses the socket then connects to. So a name
 * that answers differently on a second lookup (DNS rebinding) can't slip by. */
export async function fetchPublic(url: string, opts: FetchPublicOptions): Promise<PublicResponse> {
  const signal = AbortSignal.timeout(opts.timeoutMs);
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") throw new Error(`refused ${current.protocol} URL`);
    if (isPrivateHost(current.hostname)) throw new Error(`refused ${current.hostname}: ${LOCAL_NETWORK}`);
    const res = await getOnce(current, opts, signal);
    if (!res.location) return res;
    current = new URL(res.location, current);
  }
  throw new Error(`too many redirects from ${url}`);
}

/** A resolver for http(s).request that refuses names landing on this machine or
 * its network. Node calls it for names only; address literals never reach it. */
function refusingLookup(opts: FetchPublicOptions): LookupFunction {
  const resolve = opts.lookup ?? systemLookup;
  const refused = opts.isRefusedAddress ?? isPrivateHost;
  return (hostname, options, callback) => {
    resolve(hostname)
      .then((found) => {
        const addrs = found
          .map((a) => ({ address: a.address, family: a.address.includes(":") ? 6 : 4 }))
          .filter((a) => !options.family || a.family === options.family);
        if (!addrs.length) throw Object.assign(new Error(`couldn't find ${hostname}`), { code: "ENOTFOUND" });
        if (addrs.some((a) => refused(a.address))) throw new Error(`refused ${hostname}: ${LOCAL_NETWORK}`);
        if (options.all) callback(null, addrs);
        else callback(null, addrs[0].address, addrs[0].family);
      })
      .catch((err: NodeJS.ErrnoException) => callback(err, "", 0));
  };
}

/** One GET. A redirect comes back as its location, with the body left unread. */
function getOnce(target: URL, opts: FetchPublicOptions, signal: AbortSignal): Promise<PublicResponse & { location: string | null }> {
  const client = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      target,
      // agent: false = a fresh connection, so a pooled socket opened without this check is never reused.
      { method: "GET", headers: { ...opts.headers, "accept-encoding": "gzip, deflate, br" }, lookup: refusingLookup(opts), signal, agent: false },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = status >= 300 && status < 400 ? (res.headers.location ?? null) : null;
        if (location) {
          res.resume();
          resolve({ ok: false, status, headers: res.headers, location, text: async () => "" });
          return;
        }
        readBody(res)
          .then((raw) => {
            const body = decodeBody(raw, res.headers["content-encoding"]);
            resolve({ ok: status >= 200 && status < 300, status, headers: res.headers, location: null, text: async () => body });
          })
          .catch(reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** The body as text, unzipped, never past the size cap (a small gzip can
 * expand enormously). */
function decodeBody(raw: Buffer, encoding: string | undefined): string {
  const limit = { maxOutputLength: MAX_BODY_BYTES };
  try {
    switch ((encoding ?? "").trim().toLowerCase()) {
      case "gzip":
      case "x-gzip":
        return zlib.gunzipSync(raw, limit).toString("utf8");
      case "deflate":
        return inflateEitherForm(raw, limit).toString("utf8");
      case "br":
        return zlib.brotliDecompressSync(raw, limit).toString("utf8");
      default:
        return raw.toString("utf8");
    }
  } catch (err) {
    if (err instanceof RangeError) throw new Error(TOO_LARGE);
    throw err;
  }
}

/** "deflate" is meant to carry a zlib wrapper, but some servers send raw
 * deflate; try the wrapped form, then the raw one. Too large is final. */
function inflateEitherForm(raw: Buffer, limit: zlib.ZlibOptions): Buffer {
  try {
    return zlib.inflateSync(raw, limit);
  } catch (err) {
    if (err instanceof RangeError) throw err;
    return zlib.inflateRawSync(raw, limit);
  }
}

async function readBody(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      stream.destroy();
      throw new Error(TOO_LARGE);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
