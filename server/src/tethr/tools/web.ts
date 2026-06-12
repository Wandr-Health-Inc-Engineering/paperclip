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

export const webFetchTool: TethrTool = {
  name: "web_fetch",
  description:
    "Fetch a public web page (read-only GET) and return its text content. Use for CDC/WHO/State Dept pages and other public research sources.",
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
    if (!liveFetchEnabled()) {
      const fixture =
        url.includes("cdc.gov") || url.includes("who.int") || url.includes("state.gov")
          ? CDC_FIXTURE.map((n) => `- [${n.source}] ${n.title}: ${n.summary} (${n.url})`).join("\n")
          : GENERIC_FETCH_FIXTURE(url);
      return { output: fixture, summary: `fixture for ${new URL(url).hostname}` };
    }
    try {
      const body = await politeFetch(url, "text/html,application/json");
      const text = stripHtml(body).slice(0, 6000);
      return { output: text, summary: `fetched ${new URL(url).hostname} (${text.length} chars)` };
    } catch (err) {
      logger.warn({ url, err }, "tethr web_fetch failed");
      return {
        output: `Fetch failed (${err instanceof Error ? err.message : err}). Proceed with what you know and cite cautiously.`,
        summary: `fetch failed: ${new URL(url).hostname}`,
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

export const cdcScanTool: TethrTool = {
  name: "cdc_scan",
  description:
    "Pull recent CDC/WHO/State Dept travel-health notices (read-only). Returns ranked recent items with sources.",
  inputSchema: { type: "object", properties: {}, required: [] },
  async execute() {
    if (liveFetchEnabled()) {
      try {
        const body = await politeFetch(
          "https://wwwnc.cdc.gov/travel/rss/notices.xml",
          "application/rss+xml,application/xml",
        );
        const items = [...body.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 8).map((m) => {
          const block = m[1];
          const pick = (tag: string) =>
            (block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)) ?? [])[1]
              ?.replace(/<!\[CDATA\[|\]\]>/g, "")
              .trim() ?? "";
          return `- [CDC] ${pick("title")}: ${stripHtml(pick("description")).slice(0, 200)} (${pick("link")})`;
        });
        if (items.length) {
          return { output: `Recent CDC notices (live):\n${items.join("\n")}`, summary: `cdc: ${items.length} notices (live)` };
        }
      } catch (err) {
        logger.warn({ err }, "tethr cdc_scan live fetch failed; using fixture");
      }
    }
    const lines = CDC_FIXTURE.map(
      (n) => `- [${n.source}] ${n.title} (${n.published_days_ago}d ago): ${n.summary} (${n.url})`,
    );
    return { output: `Recent notices (fixture):\n${lines.join("\n")}`, summary: `cdc: ${lines.length} notices (fixture)` };
  },
};
