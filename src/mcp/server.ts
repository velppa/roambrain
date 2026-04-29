// MCP stdio server. Wires the @modelcontextprotocol SDK to RoamBrain's
// tool registry. Returns the legacy `{ content, isError? }` response shape;
// the SDK accepts it via the ServerResult union.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import type { BrainEngine } from "../core/engine.ts";
import { TOOLS } from "./tool-defs.ts";
import { dispatchTool } from "./dispatch.ts";

const VERSION = "0.1.0";

export async function startMcpServer(engine: BrainEngine): Promise<void> {
  const server = new Server(
    { name: "roambrain", version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // The MCP SDK's response type narrowed to a discriminated union; we return
  // the legacy `{ content, isError? }` shape and cast through `any`, matching
  // gbrain's approach.
  // deno-lint-ignore no-explicit-any
  server.setRequestHandler(CallToolRequestSchema, (async (req: any): Promise<any> => {
    const { name, arguments: params } = req.params;
    try {
      const result = await dispatchTool(engine, name, params ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result, replacer, 2) }] };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  }) as never);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// JSON.stringify replacer: convert Maps and Float32Arrays to JSON-friendly forms
// so MCP clients receive readable output.
function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Float32Array) return Array.from(value);
  if (value instanceof Set) return [...value];
  return value;
}
