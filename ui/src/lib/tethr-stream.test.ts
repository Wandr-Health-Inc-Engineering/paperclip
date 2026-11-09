import { describe, expect, it } from "vitest";
import {
  closeOpenMarkdown,
  MIN_CHARS_PER_SECOND,
  rehypeStreamWords,
  revealEnd,
  smoothRate,
  STREAM_LAG_SECONDS,
  targetRate,
} from "./tethr-stream";

describe("streaming reveal pace", () => {
  it("trails the stream by a fraction of a second, with a floor", () => {
    expect(targetRate(0, true)).toBe(MIN_CHARS_PER_SECOND);
    expect(targetRate(700, true)).toBeCloseTo(700 / STREAM_LAG_SECONDS);
    expect(targetRate(700, false)).toBeGreaterThan(targetRate(700, true));
  });

  it("eases the speed toward its target instead of jumping", () => {
    const next = smoothRate(40, 400, 1 / 60);
    expect(next).toBeGreaterThan(40);
    expect(next).toBeLessThan(100);
    expect(smoothRate(40, 400, 5)).toBeCloseTo(400, 0);
  });
});

describe("where the reveal cuts", () => {
  const text = "Hello world again";

  it("cuts at word ends, never inside a word", () => {
    expect(text.slice(0, revealEnd(text, 3, true))).toBe("Hello");
    expect(text.slice(0, revealEnd(text, 7, true))).toBe("Hello world");
    expect(text.slice(0, revealEnd(text, 0, true))).toBe("");
  });

  it("holds back a word that may still be arriving, until the turn is done", () => {
    expect(text.slice(0, revealEnd(text, 99, true))).toBe("Hello world");
    expect(text.slice(0, revealEnd(text, 13, false))).toBe(text);
    expect(revealEnd("Partial", 99, true)).toBe(0);
  });

  it("never shows a bare list marker or heading mark", () => {
    const list = "- item one\n- item two";
    expect(list.slice(0, revealEnd(list, 1, true))).toBe("- item");
    expect(list.slice(0, revealEnd(list, 11, true))).toBe("- item one\n");
    expect(list.slice(0, revealEnd(list, 12, true))).toBe("- item one\n- item");
    const heading = "## Heading words more";
    expect(heading.slice(0, revealEnd(heading, 2, true))).toBe("## Heading");
    const numbered = "1. First step here";
    expect(numbered.slice(0, revealEnd(numbered, 2, true))).toBe("1. First");
  });
});

describe("closing half-written Markdown", () => {
  it("closes an open code fence, inline code or bold", () => {
    expect(closeOpenMarkdown("```js\nconst a")).toBe("```js\nconst a\n```");
    expect(closeOpenMarkdown("run `npm")).toBe("run `npm`");
    expect(closeOpenMarkdown("**Bold")).toBe("**Bold**");
    expect(closeOpenMarkdown("one **x**\n\nnew **bo")).toBe("one **x**\n\nnew **bo**");
  });

  it("leaves balanced Markdown alone", () => {
    expect(closeOpenMarkdown("**Bold** text and `code`")).toBe("**Bold** text and `code`");
    expect(closeOpenMarkdown("```\nx\n```\nafter")).toBe("```\nx\n```\nafter");
  });
});

describe("the word fade", () => {
  it("wraps each word in a span and fades code whole", () => {
    const tree = {
      type: "root",
      children: [
        { type: "element", tagName: "p", children: [{ type: "text", value: "Hi there" }] },
        { type: "element", tagName: "pre", children: [{ type: "element", tagName: "code", children: [{ type: "text", value: "a b" }] }] },
      ],
    };
    rehypeStreamWords()(tree);
    const [p, pre] = tree.children as Array<{ children: Array<{ type: string; tagName?: string; value?: string; properties?: { className?: string[] } }>; properties?: { className?: string[] } }>;
    expect(p.children.map((c) => c.tagName ?? c.value)).toEqual(["span", " ", "span"]);
    expect(p.children[0].properties?.className).toEqual(["tethr-w"]);
    expect(pre.properties?.className).toEqual(["tethr-w"]);
  });
});
