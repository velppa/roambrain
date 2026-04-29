#!/usr/bin/env bun
// RoamBrain CLI entrypoint.
//
//   roambrain mcp                    start MCP stdio server
//   roambrain call <tool> [<json>]   invoke a tool directly (debugging)
//   roambrain tools                  list registered tools
//
// Engine: PGLite at $ROAMBRAIN_DB or ~/.config/roambrain/brain.pglite.
// Org Roam DB: $ROAMBRAIN_ORG_ROAM_DB if set; otherwise queried from Emacs
// via roambrain-org-roam-db-location. If Emacs is unavailable, graph reads
// throw — pure-PGLite tools still work.

import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { mkdirSync } from "node:fs";

import { PgliteEngine } from "./core/pglite-engine.ts";
import { OrgRoamDb } from "./core/org-roam-db.ts";
import { EmacsClient } from "./core/emacs.ts";
import { runSync } from "./core/sync.ts";
import { embedBatch } from "./core/embedding.ts";
import { TOOLS } from "./mcp/tool-defs.ts";
import { dispatchTool } from "./mcp/dispatch.ts";
import { startMcpServer } from "./mcp/server.ts";

const [, , cmd, ...args] = process.argv;

if (!cmd || cmd === "--help" || cmd === "-h") {
  printHelp();
  process.exit(0);
}

switch (cmd) {
  case "mcp":   await runMcp();        break;
  case "call":  await runCall(args);   break;
  case "tools": runTools();            break;
  case "index": await runIndex(args);  break;
  default:
    console.error(`roambrain: unknown command '${cmd}'`);
    printHelp();
    process.exit(1);
}

interface BuiltEngine {
  engine: PgliteEngine;
  emacs: EmacsClient | null;
  orgRoam: OrgRoamDb | null;
}

async function buildEngine(): Promise<BuiltEngine> {
  const dbPath = process.env.ROAMBRAIN_DB ?? resolve(homedir(), ".config/roambrain/brain.pglite");
  // PGLite's NodeFS only mkdirs the leaf — make sure the parent exists.
  mkdirSync(dirname(dbPath), { recursive: true });

  const emacs = new EmacsClient();
  let emacsAlive = true;

  let orgRoamPath = process.env.ROAMBRAIN_ORG_ROAM_DB;
  if (!orgRoamPath) {
    try {
      orgRoamPath = await emacs.callJson<string>("(roambrain-org-roam-db-location)");
    } catch {
      emacsAlive = false;
    }
  }

  // Pull OPENAI_API_KEY from auth-source if not already in env.
  if (!process.env.OPENAI_API_KEY && emacsAlive) {
    try {
      const key = await emacs.callJson<string>("(roambrain-openai-key)");
      if (key) process.env.OPENAI_API_KEY = key;
    } catch {
      // non-fatal
    }
  }

  const orgRoam = orgRoamPath ? new OrgRoamDb({ path: orgRoamPath }) : null;
  const engine = new PgliteEngine({ orgRoam: orgRoam ?? undefined });
  await engine.connect({ database_path: dbPath });
  await engine.initSchema();
  return { engine, emacs: emacsAlive ? emacs : null, orgRoam };
}

async function runMcp(): Promise<void> {
  const { engine } = await buildEngine();
  await startMcpServer(engine);
}

async function runCall(args: string[]): Promise<void> {
  const [tool, jsonArg] = args;
  if (!tool) {
    console.error("usage: roambrain call <tool> [<json-params>]");
    process.exit(1);
  }
  let params: Record<string, unknown> = {};
  if (jsonArg) {
    try { params = JSON.parse(jsonArg); }
    catch (e) { console.error(`invalid JSON: ${(e as Error).message}`); process.exit(1); }
  }
  const { engine } = await buildEngine();
  try {
    const out = await dispatchTool(engine, tool, params);
    console.log(JSON.stringify(out, replacer, 2));
  } finally {
    await engine.disconnect();
  }
}

async function runIndex(args: string[]): Promise<void> {
  const reembed = args.includes("--reembed");
  const { engine, emacs, orgRoam } = await buildEngine();
  if (!emacs || !orgRoam) {
    console.error("roambrain index: requires Emacs (for parsing) and org-roam.db");
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error("note: OPENAI_API_KEY not set — chunks will be stored without embeddings");
  }
  try {
    const result = await runSync(engine, emacs, orgRoam, {
      reembed,
      embedFn: process.env.OPENAI_API_KEY ? (texts) => embedBatch(texts) : undefined,
      onPage: ({ i, n, id, file, skipped }) => {
        if (skipped) return;
        console.error(`[${i}/${n}] ${id}  ${file}`);
      },
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await engine.disconnect();
  }
}

function runTools(): void {
  for (const t of TOOLS) console.log(`${t.name.padEnd(24)} — ${t.description}`);
}

function printHelp(): void {
  console.log("roambrain <command> [args]");
  console.log("");
  console.log("commands:");
  console.log("  mcp                       start MCP stdio server");
  console.log("  call <tool> [<json>]      invoke a tool directly");
  console.log("  tools                     list registered tools");
  console.log("  index [--reembed]         walk org-roam.db, parse + chunk + embed all pages");
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Float32Array) return Array.from(value);
  if (value instanceof Set) return [...value];
  return value;
}
