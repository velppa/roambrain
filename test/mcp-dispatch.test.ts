import { describe, expect, beforeEach, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PgliteEngine } from "../src/core/pglite-engine.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { TOOLS, TOOL_BY_NAME } from "../src/mcp/tool-defs.ts";

let engine: PgliteEngine;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "rb-mcp-"));
  engine = new PgliteEngine();
  await engine.connect({ database_path: dir });
  await engine.initSchema();
});

describe("tool registry", () => {
  test("exposes 24 tools with unique names", () => {
    expect(TOOLS).toHaveLength(24);
    expect(TOOL_BY_NAME.size).toBe(24);
  });

  test("every tool has type:object inputSchema", () => {
    for (const t of TOOLS) {
      expect(t.inputSchema.type).toBe("object");
      expect(typeof t.description).toBe("string");
    }
  });
});

describe("dispatchTool", () => {
  test("rejects unknown tool", async () => {
    await expect(dispatchTool(engine, "nope", {})).rejects.toThrow(/Unknown tool/);
  });

  test("rejects missing required params", async () => {
    await expect(dispatchTool(engine, "get_page", {})).rejects.toThrow(/missing required/);
  });

  test("put_page → get_page round-trip via dispatch", async () => {
    await dispatchTool(engine, "put_page", {
      id: "T1",
      title: "Test",
      properties: { FILE: "/t.org" },
      compiled_truth: "body",
    });
    const got = await dispatchTool(engine, "get_page", { id: "T1" }) as { id: string; title: string };
    expect(got.id).toBe("T1");
    expect(got.title).toBe("Test");
  });

  test("get_stats returns counts", async () => {
    const stats = await dispatchTool(engine, "get_stats", {}) as { page_count: number };
    expect(stats.page_count).toBe(0);
  });

  test("add_tag / get_tags / remove_tag work via dispatch", async () => {
    await dispatchTool(engine, "put_page", {
      id: "T2", title: "T", properties: { FILE: "/t.org" }, compiled_truth: "",
    });
    await dispatchTool(engine, "add_tag", { id: "T2", tag: "alpha" });
    expect(await dispatchTool(engine, "get_tags", { id: "T2" })).toEqual(["alpha"]);
    await dispatchTool(engine, "remove_tag", { id: "T2", tag: "alpha" });
    expect(await dispatchTool(engine, "get_tags", { id: "T2" })).toEqual([]);
  });
});
