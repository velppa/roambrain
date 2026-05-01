// RoamBrain MCP tools. 21 tools, slimmed from gbrain's surface — pages keyed
// by Org Roam :ID: (string), no slug fuzzy resolution, no auto-link / auto-
// timeline (writes through Emacs are out of scope for the MCP surface).
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
    description: "Read a page by Org Roam :ID:. Returns the indexed metadata + tags.",
    inputSchema: { type: "object", properties: { id: str("Org Roam node ID") }, required: ["id"] },
    handler: async (engine, p) => {
      const page = await engine.getPage(p.id as string);
      if (!page) throw new Error(`Page not found: ${p.id}`);
      return page satisfies OrgPage;
    },
  },
  {
    name: "put_page",
    description: "Insert or update a page's indexed metadata. `properties.FILE` (absolute path) is required.",
    inputSchema: {
      type: "object",
      properties: {
        id: str("Org Roam :ID: (omit to auto-generate a timestamp ID)"),
        title: str("Page title"),
        tags: strArr("File tags"),
        properties: obj("PROPERTIES drawer keys (must include FILE)"),
        compiled_truth: str("Page body minus the * Changelog subtree"),
        timeline: str("Body of the * Changelog heading, if any"),
      },
      required: ["title", "properties", "compiled_truth"],
    },
    handler: async (engine, p) => {
      return engine.putPage({
        id: p.id as string | undefined,
        title: p.title as string,
        tags: p.tags as string[] | undefined,
        properties: p.properties as Record<string, string>,
        compiled_truth: p.compiled_truth as string,
        timeline: p.timeline as string | undefined,
      } satisfies OrgPageInput);
    },
  },
  {
    name: "delete_page",
    description: "Delete an indexed page. Cascades to chunks, tags, timeline, raw_data, versions.",
    inputSchema: { type: "object", properties: { id: str("Org Roam node ID") }, required: ["id"] },
    handler: async (engine, p) => {
      await engine.deletePage(p.id as string);
      return { deleted: p.id };
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
  {
    name: "query",
    description: "Alias of search. Kept for GBrain-compatible callers (e.g. WUPHF) that hardcode the `query` tool name. Same params + response shape as search; `detail` is accepted and ignored.",
    inputSchema: {
      type: "object",
      properties: {
        query: str("Search query"),
        limit: int("Max results (default 20, max 100)"),
        offset: int("Pagination offset"),
        tag: str("Restrict to pages with this tag"),
        detail: str("Ignored. Accepted for GBrain shim compatibility."),
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
    name: "add_tag",
    description: "Add a filetag to the page (mirrored locally; org-roam.db is authoritative).",
    inputSchema: { type: "object", properties: { id: str("Page id"), tag: str("Tag name") }, required: ["id", "tag"] },
    handler: async (engine, p) => { await engine.addTag(p.id as string, p.tag as string); return { ok: true }; },
  },
  {
    name: "remove_tag",
    description: "Remove a filetag from the local mirror.",
    inputSchema: { type: "object", properties: { id: str("Page id"), tag: str("Tag name") }, required: ["id", "tag"] },
    handler: async (engine, p) => { await engine.removeTag(p.id as string, p.tag as string); return { ok: true }; },
  },
  {
    name: "get_tags",
    description: "List filetags for a page.",
    inputSchema: { type: "object", properties: { id: str("Page id") }, required: ["id"] },
    handler: async (engine, p) => engine.getTags(p.id as string),
  },

  // --- Graph (read-only via org-roam.db) ---
  {
    name: "get_links",
    description: "Outbound id-links for a page. Reads from org-roam.db.",
    inputSchema: { type: "object", properties: { id: str("Page id") }, required: ["id"] },
    handler: async (engine, p) => engine.getLinks(p.id as string),
  },
  {
    name: "get_backlinks",
    description: "Pages that link TO this id. Reads from org-roam.db.",
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
    description: "Add a related link from a page. Inserts into a `* Related` H1 (created before `* Changelog` if missing), saves the file, runs org-roam-db-sync. Target is `id:<uuid>` for Org Roam nodes, or any URL (https://, file://, …). Title is auto-resolved for id: targets.",
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
    name: "remove_link",
    description: "Remove a related link from the page's `* Related` subtree (matched by target). Saves the file, runs org-roam-db-sync.",
    inputSchema: {
      type: "object",
      properties: {
        id: str("Source page :ID:"),
        target: str("Link target to remove (`id:<uuid>` or URL)"),
      },
      required: ["id", "target"],
    },
    handler: async (engine, p) => {
      await engine.removeLink(p.id as string, p.target as string);
      return { ok: true };
    },
  },
  {
    name: "find_orphans",
    description: "Pages with no incoming id-links.",
    inputSchema: { type: "object", properties: {} },
    handler: async (engine) => engine.findOrphanPages(),
  },

  // --- Timeline ---
  {
    name: "add_timeline_entry",
    description: "Append an entry to the page's timeline. Deduplicated on (id, date, summary).",
    inputSchema: {
      type: "object",
      properties: {
        id: str("Page id"),
        date: str("YYYY-MM-DD"),
        summary: str("One-line summary"),
        source: str("Origin tag (e.g. 'manual', 'meeting', tool name)"),
        detail: str("Optional long-form body"),
      },
      required: ["id", "date", "summary"],
    },
    handler: async (engine, p) => {
      await engine.addTimelineEntry(p.id as string, {
        date: p.date as string,
        summary: p.summary as string,
        source: p.source as string | undefined,
        detail: p.detail as string | undefined,
      } satisfies TimelineInput);
      return { ok: true };
    },
  },
  {
    name: "get_timeline",
    description: "Read timeline entries for a page (newest first).",
    inputSchema: {
      type: "object",
      properties: {
        id: str("Page id"),
        limit: int("Max entries (default 1000)"),
        after: str("YYYY-MM-DD lower bound (exclusive)"),
        before: str("YYYY-MM-DD upper bound (exclusive)"),
      },
      required: ["id"],
    },
    handler: async (engine, p) => engine.getTimeline(p.id as string, {
      limit: p.limit as number | undefined,
      after: p.after as string | undefined,
      before: p.before as string | undefined,
    } satisfies TimelineOpts),
  },

  // --- Raw data sidecar ---
  {
    name: "put_raw_data",
    description: "Store sidecar JSON for a page from an external source. Replaces any existing row for (page_id, source).",
    inputSchema: {
      type: "object",
      properties: { id: str("Page id"), source: str("Source tag, e.g. 'openai'"), data: obj("Arbitrary JSON") },
      required: ["id", "source", "data"],
    },
    handler: async (engine, p) => { await engine.putRawData(p.id as string, p.source as string, p.data as object); return { ok: true }; },
  },
  {
    name: "get_raw_data",
    description: "Fetch sidecar JSON for a page; optionally filter by source.",
    inputSchema: {
      type: "object",
      properties: { id: str("Page id"), source: str("Source tag (omit for all)") },
      required: ["id"],
    },
    handler: async (engine, p) => engine.getRawData(p.id as string, p.source as string | undefined),
  },

  // --- Versioning ---
  {
    name: "create_version",
    description: "Snapshot the page's current compiled_truth + properties.",
    inputSchema: { type: "object", properties: { id: str("Page id") }, required: ["id"] },
    handler: async (engine, p) => engine.createVersion(p.id as string),
  },
  {
    name: "revert_version",
    description: "Restore a page's compiled_truth from a prior version.",
    inputSchema: {
      type: "object",
      properties: { id: str("Page id"), version_id: int("Version id from create_version") },
      required: ["id", "version_id"],
    },
    handler: async (engine, p) => { await engine.revertToVersion(p.id as string, p.version_id as number); return { ok: true }; },
  },

  // --- Brain status ---
  {
    name: "get_stats",
    description: "Aggregate counts: pages, chunks, embedded chunks, links, tags, timeline entries.",
    inputSchema: { type: "object", properties: {} },
    handler: async (engine) => engine.getStats(),
  },
  {
    name: "sync_brain",
    description: "Run org-roam-db-sync via Emacs and re-index any pages whose disk mtime is newer than the brain.",
    inputSchema: { type: "object", properties: {} },
    handler: async (engine) => engine.syncBrain(),
  },
  {
    name: "get_ingest_log",
    description: "Recent ingest log entries, newest first.",
    inputSchema: {
      type: "object",
      properties: { limit: int("Max rows (default 50)") },
    },
    handler: async (engine, p) => engine.getIngestLog({ limit: p.limit as number | undefined }),
  },
];

export const TOOL_BY_NAME: Map<string, ToolDef> = new Map(TOOLS.map((t) => [t.name, t]));
