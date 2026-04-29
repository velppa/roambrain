import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { EmacsClient } from "../src/core/emacs.ts";
import { parseOrgFile, serializeOrgDocument } from "../src/core/org.ts";

const emacs = new EmacsClient();

let alive = false;
try {
  await emacs.eval("t");
  alive = true;
} catch {
  // No Emacs server — skip.
}

const FIXTURE = resolve(import.meta.dir, "fixtures/sample.org");

describe.if(alive)("parseOrgFile", () => {
  test("extracts title, tags, properties", async () => {
    const doc = await parseOrgFile(emacs, FIXTURE, { validate: true });
    expect(doc.title).toBe("Sample Page");
    expect(doc.tags).toEqual(["alpha", "beta"]);
    expect(doc.properties.ID).toBe("SAMPLE-FIXTURE-0001");
    expect(doc.errors).toEqual([]);
  });

  test("splits compiled truth from changelog", async () => {
    const doc = await parseOrgFile(emacs, FIXTURE);
    expect(doc.compiled_truth).toContain("* Feature X");
    expect(doc.compiled_truth).toContain("* Insight");
    expect(doc.compiled_truth).not.toContain("* Changelog");
    expect(doc.compiled_truth).not.toContain("created the page");

    expect(doc.timeline).toContain("created the page");
    expect(doc.timeline).toContain("added insight");
    expect(doc.timeline).not.toMatch(/^\* Changelog/);
  });

  test("serialize round-trip is structurally equivalent", async () => {
    const doc = await parseOrgFile(emacs, FIXTURE);
    const out = serializeOrgDocument(doc);

    expect(out).toMatch(/:ID:\s+SAMPLE-FIXTURE-0001/);
    expect(out).toContain("#+title: Sample Page");
    expect(out).toContain("#+filetags: :alpha:beta:");
    expect(out).toContain("* Feature X");
    expect(out).toContain("* Changelog");
    expect(out.indexOf("* Changelog")).toBeGreaterThan(out.indexOf("* Insight"));
  });
});
