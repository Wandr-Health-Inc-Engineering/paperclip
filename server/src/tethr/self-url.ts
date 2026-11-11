// The address a chat turn's approval hook and tools bridge use to call this server.
//
// Always the server's own listener, never PAPERCLIP_API_URL: that can name a public
// host (a tunnel, an allowed hostname, a deploy URL) the server can't reach itself
// through. Starting tethr with PAPERCLIP_ALLOWED_HOSTNAMES=<an ngrok host> made it
// http://<ngrok host>:3100, every hook call failed, and the chat reported its tools
// as unreachable (2026-11-09).

const ANY_ADDRESS = new Set(["", "0.0.0.0", "::", "localhost"]);

function loopbackFor(bindHost: string): string {
  const host = bindHost.trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (ANY_ADDRESS.has(host) || host.startsWith("127.")) return "127.0.0.1";
  return host.includes(":") ? `[${host}]` : host;
}

export function selfApiUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TETHR_HOOK_URL?.trim();
  if (override) return override.replace(/\/+$/, "");
  const port = Number(env.PAPERCLIP_LISTEN_PORT) || 3100;
  return `http://${loopbackFor(env.PAPERCLIP_LISTEN_HOST ?? "")}:${port}`;
}
