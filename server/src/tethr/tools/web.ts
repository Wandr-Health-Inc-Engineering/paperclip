import { logger } from "../../middleware/logger.js";
import { CDC_FIXTURE, GENERIC_FETCH_FIXTURE, REDDIT_FIXTURE } from "./fixtures.js";
import { liveFetchEnabled, type TethrTool } from "./types.js";

// Read-only public-web tools. Live mode (TETHR_LIVE_FETCH=true) does real,
// unauthenticated GETs with a polite rate limit; otherwise deterministic
// fixtures. These tools NEVER write or authenticate anywhere.

const USER_AGENT = "TethrLocal/1.0 (read-only research; contact: local)";
const MIN_INTERVAL_MS = 1100;
let lastFetchAt = 0;

async function politeFetch(url: string, accept: string): Promise<string> {
  const wait = lastFetchAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFetchAt = Date.now();
  const res = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept },
    signal: AbortSignal.timeout(10_000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.text();
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// Hosts that hard-block automated requests (Akamai/CDN bot-walls): they 403
// every server-side GET regardless of user-agent, so a fetch here always
// dead-ends. Steer the agent to a fetchable equivalent up front rather than
// letting it burn a turn and fall back to guessing.
const BOT_WALLED_HOSTS: Record<string, string> = {
  "www.cdc.gov":
    "www.cdc.gov blocks automated requests (403 for every server-side GET). Do NOT rely on it. Use the `cdc_scan` tool for CDC + WHO outbreak and travel-health notices, or fetch a machine-readable CDC host instead: wwwnc.cdc.gov (travel RSS), data.cdc.gov (surveillance API), tools.cdc.gov (content API).",
  "cdc.gov":
    "cdc.gov blocks automated requests (403). Use the `cdc_scan` tool, or wwwnc.cdc.gov / data.cdc.gov / tools.cdc.gov.",
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export const webFetchTool: TethrTool = {
  name: "web_fetch",
  description:
    "Fetch a public web page (read-only GET) and return its text content. For CDC/WHO outbreak or travel-health data prefer the `cdc_scan` tool — www.cdc.gov blocks automated requests.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL to fetch" },
    },
    required: ["url"],
  },
  async execute(_ctx, input) {
    const url = String(input.url ?? "");
    if (!/^https?:\/\//.test(url)) {
      return { output: "Error: url must be absolute http(s).", summary: "invalid url" };
    }
    const host = hostOf(url);
    if (!liveFetchEnabled()) {
      const fixture =
        url.includes("cdc.gov") || url.includes("who.int") || url.includes("state.gov")
          ? CDC_FIXTURE.map((n) => `- [${n.source}] ${n.title}: ${n.summary} (${n.url})`).join("\n")
          : GENERIC_FETCH_FIXTURE(url);
      return { output: fixture, summary: `fixture for ${host}` };
    }
    // Known bot-wall: don't waste the fetch — hand back the working alternative.
    const walled = BOT_WALLED_HOSTS[host];
    if (walled) {
      return { output: `Blocked source. ${walled}`, summary: `blocked host: ${host}` };
    }
    try {
      const body = await politeFetch(url, "text/html,application/json");
      const text = stripHtml(body).slice(0, 6000);
      return { output: text, summary: `fetched ${host} (${text.length} chars)` };
    } catch (err) {
      logger.warn({ url, err }, "tethr web_fetch failed");
      // Do NOT tell the agent to "proceed with what you know" — that invites
      // fabrication. Report the failure and point at real, fetchable sources.
      return {
        output: `Fetch failed (${err instanceof Error ? err.message : err}). This source is unavailable — try a different URL, or the \`cdc_scan\`/\`reddit_scan\`/\`keyword_ideas\` tools for structured data. Do NOT invent facts, figures, or quotes for a source you could not read; say plainly what could not be verified.`,
        summary: `fetch failed: ${host}`,
      };
    }
  },
};

interface RedditPost {
  title: string;
  subreddit: string;
  author: string;
  ups: number;
  num_comments: number;
  created_hours_ago: number;
  selftext: string;
  permalink: string;
}

export const redditScanTool: TethrTool = {
  name: "reddit_scan",
  description:
    "Scan a subreddit's newest posts (public JSON, read-only). Returns recent post titles, bodies, and engagement. NEVER posts or votes.",
  inputSchema: {
    type: "object",
    properties: {
      subreddit: { type: "string", description: "Subreddit name without r/, e.g. travel" },
      query: { type: "string", description: "Optional keyword filter applied to titles/bodies" },
    },
    required: ["subreddit"],
  },
  async execute(_ctx, input) {
    const subreddit = String(input.subreddit ?? "travel").replace(/^r\//, "");
    const query = input.query ? String(input.query).toLowerCase() : null;

    let posts: RedditPost[];
    let mode: string;
    if (!liveFetchEnabled()) {
      posts = REDDIT_FIXTURE.travel;
      mode = "fixture";
    } else {
      try {
        const body = await politeFetch(
          `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/new.json?limit=15`,
          "application/json",
        );
        const json = JSON.parse(body) as {
          data?: { children?: Array<{ data: Record<string, unknown> }> };
        };
        posts = (json.data?.children ?? []).map(({ data }) => ({
          title: String(data.title ?? ""),
          subreddit: String(data.subreddit ?? subreddit),
          author: `u/${String(data.author ?? "unknown")}`,
          ups: Number(data.ups ?? 0),
          num_comments: Number(data.num_comments ?? 0),
          created_hours_ago: Math.max(
            0,
            Math.round((Date.now() / 1000 - Number(data.created_utc ?? 0)) / 3600),
          ),
          selftext: String(data.selftext ?? "").slice(0, 400),
          permalink: String(data.permalink ?? ""),
        }));
        mode = "live";
      } catch (err) {
        logger.warn({ subreddit, err }, "tethr reddit_scan live fetch failed; using fixture");
        posts = REDDIT_FIXTURE.travel;
        mode = "fixture (live fetch failed)";
      }
    }

    const filtered = query
      ? posts.filter(
          (p) =>
            p.title.toLowerCase().includes(query) || p.selftext.toLowerCase().includes(query),
        )
      : posts;
    const lines = filtered
      .slice(0, 10)
      .map(
        (p) =>
          `- r/${p.subreddit} · "${p.title}" by ${p.author} · ${p.ups}↑ ${p.num_comments} comments · ${p.created_hours_ago}h ago\n  ${p.selftext.slice(0, 220)}\n  https://reddit.com${p.permalink}`,
      );
    return {
      output: lines.length
        ? `${filtered.length} recent posts (${mode}):\n${lines.join("\n")}`
        : `No recent posts matched${query ? ` "${query}"` : ""} (${mode}).`,
      summary: `r/${subreddit}: ${filtered.length} posts (${mode})`,
    };
  },
};

// CDC travel-health notices — the wwwnc.cdc.gov RSS is fetchable server-side
// (unlike the bot-walled www.cdc.gov). Travel-focused: Zika, measles, etc.
async function scanCdcTravelNotices(): Promise<string[]> {
  const body = await politeFetch(
    "https://wwwnc.cdc.gov/travel/rss/notices.xml",
    "application/rss+xml,application/xml",
  );
  return [...body.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .slice(0, 6)
    .map((m) => {
      const block = m[1];
      const pick = (tag: string) =>
        (block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)) ?? [])[1]
          ?.replace(/<!\[CDATA\[|\]\]>/g, "")
          .trim() ?? "";
      const title = pick("title");
      return title
        ? `- [CDC] ${title}: ${stripHtml(pick("description")).slice(0, 180)} (${pick("link")})`
        : "";
    })
    .filter(Boolean);
}

// WHO Disease Outbreak News — OData JSON, fetchable server-side. Covers global
// and non-travel outbreaks (foodborne, zoonotic) that the CDC travel feed misses.
async function scanWhoOutbreakNews(): Promise<string[]> {
  const raw = await politeFetch(
    "https://www.who.int/api/news/diseaseoutbreaknews?$orderby=PublicationDateAndTime%20desc&$top=6&$select=Title,PublicationDateAndTime,ItemDefaultUrl",
    "application/json",
  );
  const data = JSON.parse(raw) as { value?: Array<Record<string, unknown>> };
  return (Array.isArray(data.value) ? data.value : [])
    .slice(0, 6)
    .map((it) => {
      const title = String(it.Title ?? "").trim();
      if (!title) return "";
      const date = String(it.PublicationDateAndTime ?? "").slice(0, 10);
      const slug = String(it.ItemDefaultUrl ?? "").replace(/^\//, "");
      const link = slug
        ? `https://www.who.int/emergencies/disease-outbreak-news/item/${slug}`
        : "https://www.who.int/emergencies/disease-outbreak-news";
      return `- [WHO] ${title} (${date}) (${link})`;
    })
    .filter(Boolean);
}

export const cdcScanTool: TethrTool = {
  name: "cdc_scan",
  description:
    "Pull recent CDC travel-health notices and WHO Disease Outbreak News (read-only, from fetchable public feeds). Returns ranked recent outbreak items with sources. Use this for outbreak/health research — www.cdc.gov blocks direct fetches.",
  inputSchema: { type: "object", properties: {}, required: [] },
  async execute() {
    if (liveFetchEnabled()) {
      // Both sources are independent — one failing must not sink the other.
      const [cdc, who] = await Promise.all([
        scanCdcTravelNotices().catch((err) => {
          logger.warn({ err }, "tethr cdc_scan: CDC travel RSS failed");
          return [] as string[];
        }),
        scanWhoOutbreakNews().catch((err) => {
          logger.warn({ err }, "tethr cdc_scan: WHO outbreak news failed");
          return [] as string[];
        }),
      ]);
      const items = [...cdc, ...who];
      if (items.length) {
        return {
          output: `Recent outbreak & travel-health notices (live):\n${items.join("\n")}`,
          summary: `cdc/who: ${items.length} notices (live)`,
        };
      }
    }
    const lines = CDC_FIXTURE.map(
      (n) => `- [${n.source}] ${n.title} (${n.published_days_ago}d ago): ${n.summary} (${n.url})`,
    );
    return { output: `Recent notices (fixture):\n${lines.join("\n")}`, summary: `cdc: ${lines.length} notices (fixture)` };
  },
};
