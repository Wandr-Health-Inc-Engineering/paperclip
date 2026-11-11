import { describe, it, expect } from "vitest";
import {
  checkMeta,
  checkJsonLd,
  checkTrackingTags,
  checkBrokenLinks,
  checkDuplicateTitles,
  extractInternalLinks,
  selectFindingsToPost,
  runSiteAudit,
  type SiteFinding,
  type AuditDeps,
} from "../tethr/checks/site-audit.js";

const GA4 = "G-WP11MQFLQ5";
const GTM = "GTM-N7K829F8";

const CLEAN = `<!doctype html><html><head>
<title>Peru Travel Health Guide | Wandr</title>
<meta name="description" content="Everything you need to stay healthy on your trip to Peru: altitude, vaccines, and a travel-medicine consult from Wandr.">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"Peru Travel Health"}</script>
<script>gtag('config','${GA4}');</script>
<!-- Google Tag Manager: ${GTM} -->
</head><body>
<a href="/destinations/peru">Peru</a><a href="https://external.com/x">ext</a><a href="mailto:x@y.com">mail</a>
</body></html>`;

describe("checkMeta", () => {
  it("passes a clean page", () => {
    expect(checkMeta(CLEAN, "https://travelwithwandr.com/")).toEqual([]);
  });
  it("flags a missing title", () => {
    const f = checkMeta("<html><head></head></html>", "https://x.com/");
    expect(f.some((x) => x.checkType === "meta_title" && x.fingerprint.endsWith(":missing"))).toBe(true);
  });
  it("flags a too-long title with the count", () => {
    const long = `<title>${"a".repeat(80)}</title><meta name="description" content="${"d".repeat(100)}">`;
    const f = checkMeta(long, "https://x.com/");
    const t = f.find((x) => x.checkType === "meta_title");
    expect(t?.fingerprint).toContain("too_long");
    expect(t?.detail?.join(" ")).toContain("80");
  });
  it("flags a missing description", () => {
    const f = checkMeta("<title>ok fine title here</title>", "https://x.com/");
    expect(f.some((x) => x.checkType === "meta_description" && x.fingerprint.endsWith(":missing"))).toBe(true);
  });
});

describe("checkJsonLd", () => {
  it("passes when the expected @type is present", () => {
    expect(checkJsonLd(CLEAN, "https://x.com/", ["Article"])).toEqual([]);
  });
  it("flags missing JSON-LD when a type is expected", () => {
    const f = checkJsonLd("<html><head></head></html>", "https://x.com/", ["Article"]);
    expect(f[0].fingerprint).toContain(":missing");
  });
  it("flags malformed JSON-LD", () => {
    const bad = `<script type="application/ld+json">{not json}</script>`;
    const f = checkJsonLd(bad, "https://x.com/", []);
    expect(f.some((x) => x.fingerprint.includes("malformed"))).toBe(true);
  });
  it("flags a present-but-wrong @type", () => {
    const f = checkJsonLd(CLEAN, "https://x.com/", ["MedicalWebPage"]);
    expect(f.some((x) => x.fingerprint.includes("missing_MedicalWebPage"))).toBe(true);
  });
  it("reads @type out of an @graph", () => {
    const graph = `<script type="application/ld+json">{"@graph":[{"@type":"FAQPage"}]}</script>`;
    expect(checkJsonLd(graph, "https://x.com/", ["FAQPage"])).toEqual([]);
  });
});

describe("checkTrackingTags", () => {
  it("passes when both GA4 and GTM ids appear", () => {
    expect(checkTrackingTags(CLEAN, "https://x.com/")).toEqual([]);
  });
  it("flags a missing GA4 and GTM", () => {
    const f = checkTrackingTags("<html></html>", "https://x.com/");
    expect(f.map((x) => x.fingerprint).some((fp) => fp.includes("ga4_"))).toBe(true);
    expect(f.map((x) => x.fingerprint).some((fp) => fp.includes("gtm_"))).toBe(true);
    expect(f.every((x) => x.severity === "high")).toBe(true);
  });
});

describe("extractInternalLinks", () => {
  it("keeps same-origin links, drops external/mailto/anchor", () => {
    const links = extractInternalLinks(CLEAN, "https://travelwithwandr.com/");
    expect(links).toContain("https://travelwithwandr.com/destinations/peru");
    expect(links.some((l) => l.includes("external.com"))).toBe(false);
    expect(links.some((l) => l.includes("mailto"))).toBe(false);
  });
});

describe("checkBrokenLinks", () => {
  it("flags 4xx/5xx and ignores 200", () => {
    const f = checkBrokenLinks("https://x.com/", {
      "https://x.com/ok": 200,
      "https://x.com/gone": 404,
      "https://x.com/err": 500,
    });
    expect(f).toHaveLength(2);
    expect(f.find((x) => x.fingerprint.endsWith("/gone"))?.severity).toBe("high");
  });
});

describe("checkDuplicateTitles", () => {
  it("flags a title reused across pages", () => {
    const f = checkDuplicateTitles([
      { url: "https://x.com/a", title: "Same Title" },
      { url: "https://x.com/b", title: "Same Title" },
      { url: "https://x.com/c", title: "Unique" },
    ]);
    expect(f).toHaveLength(2);
    expect(f.every((x) => x.checkType === "duplicate_title")).toBe(true);
  });
});

describe("selectFindingsToPost", () => {
  const findings: SiteFinding[] = [
    { checkType: "meta_title", url: "u", severity: "low", title: "l", why: "", fingerprint: "a" },
    { checkType: "tracking_tag", url: "u", severity: "high", title: "h", why: "", fingerprint: "b" },
    { checkType: "meta_description", url: "u", severity: "medium", title: "m", why: "", fingerprint: "c" },
    { checkType: "json_ld", url: "u", severity: "high", title: "h2", why: "", fingerprint: "d" },
  ];
  it("dedupes seen fingerprints, ranks by severity, caps the batch", () => {
    const out = selectFindingsToPost(findings, { seenFingerprints: new Set(["b"]), maxPerRun: 2 });
    expect(out.map((f) => f.fingerprint)).toEqual(["d", "c"]); // b filtered, high 'd' first, then medium 'c'
  });
});

describe("runSiteAudit (injected fetch)", () => {
  it("audits pages and aggregates findings", async () => {
    const deps: AuditDeps = {
      async fetchPage(url) {
        if (url.endsWith("/")) return { status: 200, html: CLEAN };
        return { status: 200, html: "<title>Peru Travel Health Guide | Wandr</title>" }; // dup title, no GA/GTM
      },
      async linkStatus(url) {
        return url.endsWith("/destinations/peru") ? 404 : 200;
      },
      maxLinksPerPage: 10,
    };
    const findings = await runSiteAudit(
      [
        { url: "https://travelwithwandr.com/", expectJsonLdTypes: ["Article"] },
        { url: "https://travelwithwandr.com/destinations/peru", expectJsonLdTypes: ["Article"] },
      ],
      deps,
    );
    // broken link on the home page's /destinations/peru
    expect(findings.some((f) => f.checkType === "broken_link" && f.fingerprint.includes("/destinations/peru"))).toBe(true);
    // second page missing GA4/GTM
    expect(findings.some((f) => f.checkType === "tracking_tag")).toBe(true);
    // both pages share the title -> duplicate_title
    expect(findings.some((f) => f.checkType === "duplicate_title")).toBe(true);
  });
});
