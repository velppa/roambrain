// RoamBrain shared types. Slimmer than gbrain's: pages keyed by Org Roam :ID:
// (string), no slugs, no multi-source, no code edges. Graph + tags read from
// `org-roam.db` (SQLite) at engine init; chunks + embeddings live in PGLite.

export interface OrgPage {
  /** Org Roam :ID: from the file's top PROPERTIES drawer. */
  id: string;
  /** Absolute path to the .org file. */
  file: string;
  title: string;
  tags: string[];
  properties: Record<string, string>;
  compiled_truth: string;
  timeline: string;
  updated_at: Date;
}

export interface OrgPageInput {
  /** When omitted, the engine generates one (timestamp ID matching org-roam style). */
  id?: string;
  title: string;
  tags?: string[];
  properties?: Record<string, string>;
  compiled_truth: string;
  timeline?: string;
  /** Opaque content hash (e.g. org-roam files.hash). Used by sync to skip unchanged pages. */
  content_hash?: string;
}

/** Lightweight row returned by listPages — no body, just metadata. */
export interface PageSummary {
  id: string;
  title: string;
  tags: string[];
  updated_at: Date;
}

export interface PageFilters {
  tag?: string;
  limit?: number;
  offset?: number;
  /** ISO date or YYYY-MM-DD. Filter to pages with updated_at > value. */
  updated_after?: string;
}

// Chunks ----------------------------------------------------------------

export type ChunkSource = "compiled_truth" | "timeline";

export interface Chunk {
  id: number;
  page_id: string;
  chunk_index: number;
  chunk_text: string;
  chunk_source: ChunkSource;
  embedding: Float32Array | null;
  model: string;
  token_count: number | null;
  embedded_at: Date | null;
}

export interface ChunkInput {
  chunk_index: number;
  chunk_text: string;
  chunk_source: ChunkSource;
  embedding?: Float32Array;
  model?: string;
  token_count?: number;
}

/** Lightweight row used by `embed --stale`. Embedding column omitted by design. */
export interface StaleChunkRow {
  page_id: string;
  chunk_index: number;
  chunk_text: string;
  chunk_source: ChunkSource;
  model: string | null;
  token_count: number | null;
}

// Search ----------------------------------------------------------------

export interface SearchResult {
  page_id: string;
  title: string;
  chunk_text: string;
  chunk_source: ChunkSource;
  chunk_id: number;
  chunk_index: number;
  score: number;
  /** True when the chunk's embedding is older than the page's content_hash. */
  stale: boolean;
}

export interface SearchOpts {
  limit?: number;
  offset?: number;
  tag?: string;
  exclude_ids?: string[];
}

// Graph -----------------------------------------------------------------

export interface Link {
  from_id: string;
  to_id: string;
  /** Surrounding text snippet, when available from org-roam.db. */
  context: string;
}

export interface GraphNode {
  id: string;
  title: string;
  depth: number;
  links: { to_id: string }[];
}

// Timeline --------------------------------------------------------------

export interface TimelineEntry {
  id: number;
  page_id: string;
  date: string;
  source: string;
  summary: string;
  detail: string;
  created_at: Date;
}

export interface TimelineInput {
  date: string;
  source?: string;
  summary: string;
  detail?: string;
}

export interface TimelineOpts {
  limit?: number;
  after?: string;
  before?: string;
}

// Misc ------------------------------------------------------------------

export interface RawData {
  source: string;
  data: Record<string, unknown>;
  fetched_at: Date;
}

export interface PageVersion {
  id: number;
  page_id: string;
  compiled_truth: string;
  snapshot_at: Date;
}

export interface BrainStats {
  page_count: number;
  chunk_count: number;
  embedded_count: number;
  link_count: number;
  tag_count: number;
  timeline_entry_count: number;
}

export interface BrainHealth {
  page_count: number;
  embed_coverage: number;
  stale_pages: number;
  orphan_pages: number;
  missing_embeddings: number;
  dead_links: number;
  brain_score: number;
}

export interface IngestLogEntry {
  id: number;
  source_type: string;
  source_ref: string;
  pages_updated: string[];
  summary: string;
  created_at: Date;
}

export interface IngestLogInput {
  source_type: string;
  source_ref: string;
  pages_updated: string[];
  summary: string;
}

export interface EngineConfig {
  /** PGLite directory. Default: ~/.config/roambrain/brain.pglite */
  database_path?: string;
  /** Absolute path to org-roam.db. Default: queried from Emacs. */
  org_roam_db?: string;
  /** Org Roam notes directory. Default: queried from Emacs. */
  org_roam_directory?: string;
}

export class RoamBrainError extends Error {
  constructor(
    public problem: string,
    public cause_description: string,
    public fix: string,
  ) {
    super(`${problem}: ${cause_description}. Fix: ${fix}`);
    this.name = "RoamBrainError";
  }
}
