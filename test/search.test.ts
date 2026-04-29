import { describe, expect, beforeEach, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PgliteEngine } from "../src/core/pglite-engine.ts";
import type { SearchResult } from "../src/core/types.ts";
import { dedupResults } from "../src/core/search/dedup.ts";
import { rrfFusion, cosineSimilarity, applyBacklinkBoost } from "../src/core/search/hybrid.ts";

function mkResult(p: Partial<SearchResult> & { chunk_id: number; page_id: string }): SearchResult {
  return {
    page_id: p.page_id,
    title: p.page_id,
    chunk_text: p.chunk_text ?? "x",
    chunk_source: p.chunk_source ?? "compiled_truth",
    chunk_id: p.chunk_id,
    chunk_index: p.chunk_index ?? 0,
    score: p.score ?? 1,
    stale: false,
  };
}

describe("dedup pipeline", () => {
  test("caps chunks per page at 2 by default", () => {
    const rs = [0, 1, 2, 3].map((i) =>
      mkResult({ chunk_id: i, page_id: "A", score: 5 - i, chunk_text: `text ${i}` }),
    );
    const out = dedupResults(rs);
    const aCount = out.filter((r) => r.page_id === "A").length;
    expect(aCount).toBeLessThanOrEqual(2);
  });

  test("drops near-duplicate chunk text via Jaccard", () => {
    const a = mkResult({ chunk_id: 1, page_id: "A", chunk_text: "the quick brown fox jumps", score: 1 });
    const b = mkResult({ chunk_id: 2, page_id: "B", chunk_text: "the quick brown fox jumps", score: 0.9 });
    const out = dedupResults([a, b]);
    expect(out.map((r) => r.chunk_id)).toEqual([1]);
  });

  test("guarantees a compiled_truth chunk per page when one existed", () => {
    const timeline = mkResult({
      chunk_id: 1, page_id: "A", chunk_source: "timeline",
      chunk_text: "tl one", score: 5,
    });
    const truth = mkResult({
      chunk_id: 2, page_id: "A", chunk_source: "compiled_truth",
      chunk_text: "ct one", score: 1,
    });
    // capPerPage=1 forces the timeline chunk through; guarantee should swap in truth.
    const out = dedupResults([timeline, truth], { maxPerPage: 1 });
    expect(out.find((r) => r.page_id === "A")?.chunk_source).toBe("compiled_truth");
  });
});

describe("RRF fusion", () => {
  test("merges two ranked lists and boosts compiled_truth", () => {
    const ct = mkResult({ chunk_id: 1, page_id: "A", chunk_source: "compiled_truth", chunk_text: "ct" });
    const tl = mkResult({ chunk_id: 2, page_id: "B", chunk_source: "timeline", chunk_text: "tl" });
    const out = rrfFusion([[ct, tl], [tl, ct]], 60);
    expect(out).toHaveLength(2);
    // compiled_truth gets 2x boost after RRF normalization
    expect(out[0]!.page_id).toBe("A");
    expect(out[0]!.score).toBeGreaterThan(out[1]!.score);
  });

  test("returns empty for empty lists", () => {
    expect(rrfFusion([], 60)).toEqual([]);
    expect(rrfFusion([[]], 60)).toEqual([]);
  });
});

describe("backlink boost + cosine similarity", () => {
  test("applyBacklinkBoost multiplies scores by log factor", () => {
    const r = mkResult({ chunk_id: 1, page_id: "A", score: 1 });
    applyBacklinkBoost([r], new Map([["A", 100]]));
    expect(r.score).toBeGreaterThan(1);
    expect(r.score).toBeLessThan(2);
  });

  test("cosineSimilarity is 1 for identical vectors and 0 for orthogonal", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 5);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });
});

describe("PgliteEngine search methods", () => {
  let engine: PgliteEngine;
  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), "rb-search-"));
    engine = new PgliteEngine();
    await engine.connect({ database_path: dir });
    await engine.initSchema();
    await engine.putPage({ id: "A", title: "Alpha", properties: { FILE: "/a.org" }, compiled_truth: "x" });
    await engine.putPage({ id: "B", title: "Beta", properties: { FILE: "/b.org" }, compiled_truth: "y" });
    const eA = new Float32Array(1536); eA[0] = 1;
    const eB = new Float32Array(1536); eB[1] = 1;
    await engine.upsertChunks("A", [
      { chunk_index: 0, chunk_text: "the quick brown fox jumps over the lazy dog", chunk_source: "compiled_truth", embedding: eA },
    ]);
    await engine.upsertChunks("B", [
      { chunk_index: 0, chunk_text: "totally unrelated content about gardening", chunk_source: "compiled_truth", embedding: eB },
    ]);
  });

  test("searchKeyword finds chunks via tsvector", async () => {
    const rs = await engine.searchKeyword("quick brown fox");
    expect(rs.length).toBeGreaterThan(0);
    expect(rs[0]!.page_id).toBe("A");
  });

  test("searchVector ranks by cosine distance", async () => {
    const q = new Float32Array(1536); q[0] = 1;
    const rs = await engine.searchVector(q, { limit: 5 });
    expect(rs[0]!.page_id).toBe("A");
  });

  test("getEmbeddingsByChunkIds returns Float32Array per id", async () => {
    const chunks = await engine.getChunks("A");
    const map = await engine.getEmbeddingsByChunkIds([chunks[0]!.id]);
    expect(map.get(chunks[0]!.id)!.length).toBe(1536);
  });

  test("searchKeyword respects tag filter", async () => {
    await engine.addTag("A", "important");
    const rs = await engine.searchKeyword("quick brown fox", { tag: "important" });
    expect(rs.every((r) => r.page_id === "A")).toBe(true);
    const none = await engine.searchKeyword("quick brown fox", { tag: "nope" });
    expect(none).toEqual([]);
  });
});
