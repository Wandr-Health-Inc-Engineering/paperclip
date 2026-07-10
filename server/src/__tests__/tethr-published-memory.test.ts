import { describe, it, expect } from "vitest";
import {
  slugify,
  publishedFingerprint,
  encodePublished,
  decodePublished,
  parsePublishedCorpus,
  isDuplicateTopic,
  findPublishedDuplicate,
  isContentRequest,
  type PublishedItem,
} from "../tethr/published-memory.js";

describe("fingerprint + encode/decode", () => {
  it("slugifies and fingerprints stably", () => {
    expect(slugify("Peru Altitude Guide!")).toBe("peru-altitude-guide");
    expect(publishedFingerprint("blog", "peru-altitude-guide")).toBe(
      "published-content:blog:peru-altitude-guide",
    );
  });
  it("round-trips an item through content encoding", () => {
    const item: PublishedItem = { kind: "blog", slug: "peru-altitude-guide", title: "Peru Altitude Guide", date: "2026-05-01" };
    const decoded = decodePublished(encodePublished(item));
    expect(decoded).toEqual(item);
  });
});

describe("parsePublishedCorpus", () => {
  it("parses markdown lists with section-kind hints, links, and dates", () => {
    const corpus = `# Published blog articles
- Peru Altitude Sickness Guide (2026-05-01)
- [Machu Picchu Packing List](https://x.com/mp) — 2026-04-10

# Itineraries
- 7-Day Peru Highlights Itinerary`;
    const items = parsePublishedCorpus(corpus);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ kind: "blog", title: "Peru Altitude Sickness Guide", date: "2026-05-01" });
    expect(items[1]).toMatchObject({ kind: "blog", title: "Machu Picchu Packing List", date: "2026-04-10" });
    expect(items[2]).toMatchObject({ kind: "itinerary", title: "7-Day Peru Highlights Itinerary" });
  });
});

describe("duplicate detection", () => {
  const items = parsePublishedCorpus(`# Blog
- Peru Altitude Sickness Guide (2026-05-01)
- Japan Rail Pass Explained`);

  it("flags a request on an already-published topic", () => {
    expect(isDuplicateTopic("write a blog about peru altitude sickness", items[0])).toBe(true);
    const dup = findPublishedDuplicate("draft a post on peru altitude sickness for travelers", items);
    expect(dup?.title).toBe("Peru Altitude Sickness Guide");
  });

  it("does not flag an unrelated topic", () => {
    expect(findPublishedDuplicate("write about Kenya safari vaccinations", items)).toBeNull();
  });
});

describe("isContentRequest", () => {
  it("matches content-creation phrasing only", () => {
    expect(isContentRequest("write a blog about Peru")).toBe(true);
    expect(isContentRequest("draft an itinerary for Japan")).toBe(true);
    expect(isContentRequest("can we afford more spend on Peru ads")).toBe(false);
  });
});
