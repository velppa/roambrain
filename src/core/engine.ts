// BrainEngine — RoamBrain's storage facade. Trimmed to what the 21 MCP tools
// need. Reads of links/tags route to org-roam.db (SQLite); writes of
// chunks/embeddings/timeline/versions/raw_data/config/ingest_log live in
// PGLite. Page bodies live on disk as .org files; the engine doesn't own
// them — it indexes them.

import type {
  OrgPage,
  OrgPageInput,
  PageFilters,
  Chunk,
  ChunkInput,
  StaleChunkRow,
  SearchResult,
  SearchOpts,
  Link,
  GraphNode,
  TimelineEntry,
  TimelineInput,
  TimelineOpts,
  RawData,
  PageVersion,
  BrainStats,
  BrainHealth,
  IngestLogEntry,
  IngestLogInput,
  EngineConfig,
} from "./types.ts";

/** Maximum results returned by search operations. */
export const MAX_SEARCH_LIMIT = 100;

/** Clamp a user-provided search limit to a safe range. */
export function clampSearchLimit(
  limit: number | undefined,
  defaultLimit = 20,
  cap = MAX_SEARCH_LIMIT,
): number {
  if (limit === undefined || limit === null || !Number.isFinite(limit) || Number.isNaN(limit)) {
    return defaultLimit;
  }
  if (limit <= 0) return defaultLimit;
  return Math.min(Math.floor(limit), cap);
}

export interface BrainEngine {
  readonly kind: "pglite";

  // Lifecycle
  connect(config: EngineConfig): Promise<void>;
  disconnect(): Promise<void>;
  initSchema(): Promise<void>;

  // Pages -- bodies on disk, metadata indexed in PGLite
  getPage(id: string): Promise<OrgPage | null>;
  putPage(input: OrgPageInput): Promise<OrgPage>;
  deletePage(id: string): Promise<void>;
  listPages(filters?: PageFilters): Promise<OrgPage[]>;
  /** Every Org Roam ID known to the brain. */
  getAllIds(): Promise<Set<string>>;
  /** Map of page id → stored content_hash (omits pages with NULL hash). */
  getPageHashes(): Promise<Map<string, string>>;

  // Search
  searchKeyword(query: string, opts?: SearchOpts): Promise<SearchResult[]>;
  searchVector(embedding: Float32Array, opts?: SearchOpts): Promise<SearchResult[]>;
  getEmbeddingsByChunkIds(ids: number[]): Promise<Map<number, Float32Array>>;

  // Chunks
  upsertChunks(pageId: string, chunks: ChunkInput[]): Promise<void>;
  getChunks(pageId: string): Promise<Chunk[]>;
  countStaleChunks(): Promise<number>;
  listStaleChunks(): Promise<StaleChunkRow[]>;
  deleteChunks(pageId: string): Promise<void>;

  // Tags -- delegated to org-roam.db (filetags)
  addTag(id: string, tag: string): Promise<void>;
  removeTag(id: string, tag: string): Promise<void>;
  getTags(id: string): Promise<string[]>;

  // Links -- read from org-roam.db; writes go through Emacs
  // (insert [[id:...]] in the file, then trigger org-roam-db-sync).
  addLink(from: string, to: string, context?: string): Promise<void>;
  removeLink(from: string, to: string): Promise<void>;
  getLinks(id: string): Promise<Link[]>;
  getBacklinks(id: string): Promise<Link[]>;
  traverseGraph(id: string, depth?: number): Promise<GraphNode[]>;
  getBacklinkCounts(ids: string[]): Promise<Map<string, number>>;
  findOrphanPages(): Promise<Array<{ id: string; title: string }>>;

  // Timeline
  addTimelineEntry(id: string, entry: TimelineInput): Promise<void>;
  getTimeline(id: string, opts?: TimelineOpts): Promise<TimelineEntry[]>;

  // Raw data
  putRawData(id: string, source: string, data: object): Promise<void>;
  getRawData(id: string, source?: string): Promise<RawData[]>;

  // Versions
  createVersion(id: string): Promise<PageVersion>;
  getVersions(id: string): Promise<PageVersion[]>;
  revertToVersion(id: string, versionId: number): Promise<void>;

  // Stats / health
  getStats(): Promise<BrainStats>;
  getHealth(): Promise<BrainHealth>;

  // Ingest log
  logIngest(entry: IngestLogInput): Promise<void>;
  getIngestLog(opts?: { limit?: number }): Promise<IngestLogEntry[]>;

  // Sync -- runs (org-roam-db-sync) via emacsclient, then re-reads any pages
  // whose updated_at on disk is newer than what the brain has indexed.
  syncBrain(): Promise<{ synced: number; deleted: number }>;

  // Config
  getConfig(key: string): Promise<string | null>;
  setConfig(key: string, value: string): Promise<void>;

  // Raw SQL (for internal modules; not exposed via MCP)
  executeRaw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}
