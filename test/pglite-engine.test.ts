import { describe, expect, beforeEach, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PgliteEngine } from "../src/core/pglite-engine.ts";

let dir: string;
let engine: PgliteEngine;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "rb-engine-"));
  engine = new PgliteEngine();
  await engine.connect({ database_path: dir });
  await engine.initSchema();
});

const FIXTURE_FILE = "/Users/pavel/.velppa/roambrain/test/fixtures/sample.org";

describe("PgliteEngine — pages", () => {
  test("putPage requires properties.FILE", async () => {
    await expect(
      engine.putPage({
        title: "X",
        compiled_truth: "body",
      }),
    ).rejects.toThrow(/FILE/);
  });

  test("putPage + getPage round-trip with provided id and tags", async () => {
    const page = await engine.putPage({
      id: "TEST-001",
      title: "Sample",
      tags: ["alpha", "beta"],
      properties: { FILE: FIXTURE_FILE, CATEGORY: "concept" },
      compiled_truth: "body of truth",
      timeline: "- entry",
    });
    expect(page.id).toBe("TEST-001");
    expect(page.title).toBe("Sample");
    expect(page.file).toBe(FIXTURE_FILE);
    expect(page.tags).toEqual(["alpha", "beta"]);
    expect(page.properties.CATEGORY).toBe("concept");
    expect(page.properties.FILE).toBeUndefined();

    const got = await engine.getPage("TEST-001");
    expect(got).not.toBeNull();
    expect(got!.compiled_truth).toBe("body of truth");
    expect(got!.timeline).toBe("- entry");
  });

  test("listPages filters by tag and updated_after", async () => {
    await engine.putPage({
      id: "A", title: "A", tags: ["x"],
      properties: { FILE: "/a.org" }, compiled_truth: "",
    });
    await engine.putPage({
      id: "B", title: "B", tags: ["y"],
      properties: { FILE: "/b.org" }, compiled_truth: "",
    });
    const xs = await engine.listPages({ tag: "x" });
    expect(xs.map((p) => p.id)).toEqual(["A"]);
  });

  test("getAllIds returns every page id", async () => {
    await engine.putPage({ id: "A", title: "A", properties: { FILE: "/a.org" }, compiled_truth: "" });
    await engine.putPage({ id: "B", title: "B", properties: { FILE: "/b.org" }, compiled_truth: "" });
    const all = await engine.getAllIds();
    expect([...all].sort()).toEqual(["A", "B"]);
  });

  test("deletePage cascades to chunks and tags", async () => {
    await engine.putPage({ id: "A", title: "A", tags: ["t"], properties: { FILE: "/a.org" }, compiled_truth: "x" });
    await engine.upsertChunks("A", [{ chunk_index: 0, chunk_text: "hello world", chunk_source: "compiled_truth" }]);
    await engine.deletePage("A");
    const tags = await engine.getTags("A");
    const chunks = await engine.getChunks("A");
    expect(tags).toEqual([]);
    expect(chunks).toEqual([]);
  });
});

describe("PgliteEngine — chunks", () => {
  beforeEach(async () => {
    await engine.putPage({ id: "A", title: "A", properties: { FILE: "/a.org" }, compiled_truth: "x" });
  });

  test("upsertChunks stores text and embedding; getChunks reads back", async () => {
    const emb = new Float32Array(1536);
    emb[0] = 0.1; emb[1] = 0.2; emb[2] = 0.3;
    await engine.upsertChunks("A", [
      { chunk_index: 0, chunk_text: "first chunk", chunk_source: "compiled_truth", embedding: emb },
      { chunk_index: 1, chunk_text: "second chunk", chunk_source: "timeline" },
    ]);
    const chunks = await engine.getChunks("A");
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.chunk_text).toBe("first chunk");
    expect(chunks[0]!.embedding).not.toBeNull();
    expect(chunks[0]!.embedding!.length).toBe(1536);
    expect(chunks[1]!.embedding).toBeNull();
    expect(await engine.countStaleChunks()).toBe(1);
  });

  test("listStaleChunks omits embedded rows", async () => {
    await engine.upsertChunks("A", [
      { chunk_index: 0, chunk_text: "stale", chunk_source: "compiled_truth" },
      { chunk_index: 1, chunk_text: "ok", chunk_source: "compiled_truth", embedding: new Float32Array(1536) },
    ]);
    const stale = await engine.listStaleChunks();
    expect(stale.map((s) => s.chunk_index)).toEqual([0]);
  });
});

describe("PgliteEngine — tags / timeline / raw_data / versions / config / log", () => {
  beforeEach(async () => {
    await engine.putPage({ id: "A", title: "A", properties: { FILE: "/a.org" }, compiled_truth: "v1" });
  });

  test("addTag / removeTag / getTags", async () => {
    await engine.addTag("A", "alpha");
    await engine.addTag("A", "beta");
    expect(await engine.getTags("A")).toEqual(["alpha", "beta"]);
    await engine.removeTag("A", "alpha");
    expect(await engine.getTags("A")).toEqual(["beta"]);
  });

  test("addTimelineEntry deduplicates by (page_id, date, summary)", async () => {
    await engine.addTimelineEntry("A", { date: "2026-04-29", summary: "created" });
    await engine.addTimelineEntry("A", { date: "2026-04-29", summary: "created" });
    const t = await engine.getTimeline("A");
    expect(t).toHaveLength(1);
  });

  test("putRawData replaces by (page_id, source)", async () => {
    await engine.putRawData("A", "openai", { v: 1 });
    await engine.putRawData("A", "openai", { v: 2 });
    const got = await engine.getRawData("A", "openai");
    expect(got).toHaveLength(1);
    expect(got[0]!.data).toEqual({ v: 2 });
  });

  test("createVersion / revertToVersion", async () => {
    const v1 = await engine.createVersion("A");
    await engine.executeRaw(`UPDATE pages SET compiled_truth='v2' WHERE id='A'`);
    expect((await engine.getPage("A"))!.compiled_truth).toBe("v2");
    await engine.revertToVersion("A", v1.id);
    expect((await engine.getPage("A"))!.compiled_truth).toBe("v1");
  });

  test("config get/set", async () => {
    expect(await engine.getConfig("theme")).toBeNull();
    await engine.setConfig("theme", "dark");
    expect(await engine.getConfig("theme")).toBe("dark");
  });

  test("ingest log records entries", async () => {
    await engine.logIngest({
      source_type: "manual",
      source_ref: "test",
      pages_updated: ["A"],
      summary: "first ingest",
    });
    const log = await engine.getIngestLog();
    expect(log).toHaveLength(1);
    expect(log[0]!.source_type).toBe("manual");
    expect(log[0]!.pages_updated).toEqual(["A"]);
  });
});

describe("PgliteEngine — graph methods require an OrgRoamReader", () => {
  test("getLinks throws without reader", async () => {
    await expect(engine.getLinks("X")).rejects.toThrow(/org-roam\.db not configured/);
  });
});

// Cleanup: bun test currently has no global afterEach for top-level `dir`; we
// rely on tmpdir() cleanup at OS level. PGLite directories are small.
process.on("exit", () => {
  if (dir) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
