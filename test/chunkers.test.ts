import { describe, expect, test } from "bun:test";

import { chunkText } from "../src/core/chunkers/recursive.ts";
import { chunkOrgText, splitOrgSections } from "../src/core/chunkers/org.ts";

describe("recursive chunker", () => {
  test("returns empty for empty input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n  ")).toEqual([]);
  });

  test("returns single chunk when under target", () => {
    const out = chunkText("hello world", { chunkSize: 300 });
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("hello world");
    expect(out[0]!.index).toBe(0);
  });

  test("splits long text into multiple chunks under ~1.5x target", () => {
    const para = "The quick brown fox jumps over the lazy dog. ".repeat(60);
    const out = chunkText(para, { chunkSize: 50, chunkOverlap: 10 });
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) {
      const wc = (c.text.match(/\S+/g) || []).length;
      expect(wc).toBeLessThan(120);
    }
    expect(out.map((c) => c.index)).toEqual(out.map((_, i) => i));
  });
});

describe("org-aware splitter", () => {
  test("splitOrgSections returns whole text when no headings", () => {
    expect(splitOrgSections("just a paragraph\n\nand another")).toEqual([
      "just a paragraph\n\nand another",
    ]);
  });

  test("splitOrgSections splits at level-1 headings only", () => {
    const text = `preamble line\n\n* First\nbody1\n** Sub\nsub-body\n* Second\nbody2`;
    const out = splitOrgSections(text);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe("preamble line");
    expect(out[1]!.startsWith("* First")).toBe(true);
    expect(out[1]).toContain("** Sub");
    expect(out[2]!.startsWith("* Second")).toBe(true);
  });

  test("chunkOrgText falls through to recursive when no headings", () => {
    const out = chunkOrgText("plain prose with no headings", { chunkSize: 300 });
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("plain prose with no headings");
  });

  test("chunkOrgText emits per-section chunks with sequential indices", () => {
    const text = `* A\nalpha body\n* B\nbeta body\n* C\ngamma body`;
    const out = chunkOrgText(text, { chunkSize: 300 });
    expect(out.length).toBeGreaterThanOrEqual(3);
    expect(out.map((c) => c.index)).toEqual(out.map((_, i) => i));
    expect(out[0]!.text.startsWith("* A")).toBe(true);
  });
});
