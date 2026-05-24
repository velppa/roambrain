// RoamBrain MCP tools.
//
// Each tool declares its JSONSchema input and a handler that dispatches to
// the BrainEngine. Adding a tool: append to TOOLS, no other registration.

import type { BrainEngine } from "../core/engine.ts";
import type {
  OrgPage,
  OrgPageInput,
  PageFilters,
  TimelineInput,
  TimelineOpts,
} from "../core/types.ts";
import { hybridSearch } from "../core/search/hybrid.ts";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, JsonSchemaProp>;
    required?: string[];
  };
  handler: (engine: BrainEngine, params: Record<string, unknown>) => Promise<unknown>;
}

interface JsonSchemaProp {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description?: string;
  items?: { type: string };
  enum?: string[];
}

const str = (description: string): JsonSchemaProp => ({ type: "string", description });
const int = (description: string): JsonSchemaProp => ({ type: "integer", description });
const obj = (description: string): JsonSchemaProp => ({ type: "object", description });
const strArr = (description: string): JsonSchemaProp => ({ type: "array", items: { type: "string" }, description });

export const TOOLS: ToolDef[] = [
  // --- Pages ---
  {
    name: "get_page",
    description: "Read a page by Org :ID:. Returns the indexed metadata + tags.",
    inputSchema: { type: "object", properties: { id: str("Org ID") }, required: ["id"] },
    handler: async (engine, p) => {
      const page = await engine.getPage(p.id as string);
      if (!page) throw new Error(`Page not found: ${p.id}`);
      return page satisfies OrgPage;
    },
  },
  {
    name: "list_pages",
    description: "List indexed pages (id, title, tags, updated_at only — no body), newest first. Optional tag filter and updated_after cutoff.",
    inputSchema: {
      type: "object",
      properties: {
        tag: str("Filter to pages tagged with this filetag"),
        updated_after: str("ISO 8601 or YYYY-MM-DD; only pages updated after this"),
        limit: int("Max rows (default 100)"),
        offset: int("Pagination offset"),
      },
    },
    handler: async (engine, p) => engine.listPages(p as PageFilters),
  },
  {
    name: "recent_pages",
    description: "Pages updated in the last N days, newest first. Returns id, title, tags, updated_at — no body.",
    inputSchema: {
      type: "object",
      properties: {
        days: int("Look-back window in days (default 7)"),
        tag: str("Optional tag filter"),
        limit: int("Max rows (default 20)"),
      },
    },
    handler: async (engine, p) => {
      const days = (p.days as number | undefined) ?? 7;
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      return engine.listPages({
        updated_after: cutoff,
        tag: p.tag as string | undefined,
        limit: (p.limit as number | undefined) ?? 20,
      });
    },
  },

  // --- Search ---
  {
    name: "search",
    description: "Hybrid search: keyword + vector → RRF + cosine re-score → backlink boost → 4-layer dedup. Falls back to keyword-only when OPENAI_API_KEY is unset.",
    inputSchema: {
      type: "object",
      properties: {
        query: str("Search query"),
        limit: int("Max results (default 20, max 100)"),
        offset: int("Pagination offset"),
        tag: str("Restrict to pages with this tag"),
      },
      required: ["query"],
    },
    handler: async (engine, p) => hybridSearch(engine, p.query as string, {
      limit: p.limit as number | undefined,
      offset: p.offset as number | undefined,
      tag: p.tag as string | undefined,
    }),
  },

  // --- Tags ---
  {
    name: "get_tags",
    description: "List filetags for a page.",
    inputSchema: { type: "object", properties: { id: str("Page id") }, required: ["id"] },
    handler: async (engine, p) => engine.getTags(p.id as string),
  },

  // --- Graph (read-only via org-roam.db) ---
  {
    name: "get_links",
    description: "Outbound id-links for a page.",
    inputSchema: { type: "object", properties: { id: str("Page id") }, required: ["id"] },
    handler: async (engine, p) => engine.getLinks(p.id as string),
  },
  {
    name: "get_backlinks",
    description: "Pages that link TO this id.",
    inputSchema: { type: "object", properties: { id: str("Page id") }, required: ["id"] },
    handler: async (engine, p) => engine.getBacklinks(p.id as string),
  },
  {
    name: "traverse_graph",
    description: "BFS outward from id up to depth hops (default 2).",
    inputSchema: {
      type: "object",
      properties: { id: str("Starting page id"), depth: int("Max hops (default 2)") },
      required: ["id"],
    },
    handler: async (engine, p) => engine.traverseGraph(p.id as string, p.depth as number | undefined),
  },
  {
    name: "add_link",
    description: "Add a related link to a page.",
    inputSchema: {
      type: "object",
      properties: {
        id: str("Source page :ID:"),
        target: str("`id:<uuid>` for an Org Roam node, or a URL"),
        title: str("Optional link title (auto-resolved for id: targets)"),
      },
      required: ["id", "target"],
    },
    handler: async (engine, p) => {
      await engine.addLink(p.id as string, p.target as string, p.title as string | undefined);
      return { ok: true };
    },
  },
  {
    name: "find_orphans",
    description: "Pages with no incoming id-links.",
    inputSchema: { type: "object", properties: {} },
    handler: async (engine) => engine.findOrphanPages(),
  },
  // --- Brain status ---
  {
    name: "sync_brain",
    description: "Run org-roam-db-sync via Emacs and re-index any pages whose disk mtime is newer than the brain.",
    inputSchema: { type: "object", properties: {} },
    handler: async (engine) => engine.syncBrain(),
  },
];

export const TOOL_BY_NAME: Map<string, ToolDef> = new Map(TOOLS.map((t) => [t.name, t]));
