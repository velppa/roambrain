// Lookup + invoke tools by name. Used by the MCP stdio server and by the
// `roambrain call` CLI subcommand for direct testing.

import type { BrainEngine } from "../core/engine.ts";
import { TOOL_BY_NAME } from "./tool-defs.ts";

export async function dispatchTool(
  engine: BrainEngine,
  name: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  validateRequired(name, tool.inputSchema.required ?? [], params);
  return tool.handler(engine, params);
}

function validateRequired(
  name: string,
  required: string[],
  params: Record<string, unknown>,
): void {
  const missing = required.filter((k) => params[k] === undefined || params[k] === null);
  if (missing.length > 0) {
    throw new Error(`${name}: missing required params: ${missing.join(", ")}`);
  }
}
