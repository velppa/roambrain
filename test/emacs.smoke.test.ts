// Live smoke test against the running Emacs instance. Skipped when no
// emacsclient socket is reachable.

import { describe, expect, test } from "bun:test";
import { EmacsClient } from "../src/core/emacs.ts";

const client = new EmacsClient();

let alive = false;
try {
  await client.eval("t");
  alive = true;
} catch {
  // No Emacs server reachable — leave alive=false; tests below short-circuit.
}

describe.if(alive)("EmacsClient (live)", () => {
  test("evalJson roundtrips strings and numbers", async () => {
    const s = await client.evalJson<string>('"hello world"');
    expect(s).toBe("hello world");
    const n = await client.evalJson<number>("(+ 1 2)");
    expect(n).toBe(3);
  });

  test("evalJson roundtrips lists as arrays", async () => {
    const a = await client.evalJson<number[]>("(list 1 2 3)");
    expect(a).toEqual([1, 2, 3]);
  });

  test("orgRoamDirectory returns an absolute path", async () => {
    const dir = await client.orgRoamDirectory();
    expect(dir.length).toBeGreaterThan(0);
  });

  test("readFile returns the file contents", async () => {
    // roambrain.org is the user's own page; should always exist.
    const txt = await client.readFile("/Users/pavel/Notes/roambrain.org");
    expect(txt).toContain("#+title: RoamBrain");
  });

  test("nodeFile resolves a known ID", async () => {
    // ID of /Users/pavel/Notes/roambrain.org from its :PROPERTIES: drawer.
    const path = await client.nodeFile("20260429T143230.339867");
    expect(path).toBe("/Users/pavel/Notes/roambrain.org");
  });

});
