// PGLite-backed implementation of BrainEngine. Stores indexed page metadata,
// chunks + embeddings, timeline rows, raw_data, versions, ingest log, and
// config. Graph (links/backlinks/orphans) reads delegate to the org-roam.db
// SQLite database via OrgRoamDb. Page bodies live on disk as .org files —
// the engine never owns them.

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { homedir } from "node:os";
import { resolve } from "node:path";

import schemaSql from "../schema.sql" with { type: "text" };

import type { BrainEngine } from "./engine.ts";
import { clampSearchLimit as clampLimit } from "./engine.ts";
import type {
  BrainHealth,
  BrainStats,
  Chunk,
  ChunkInput,
  EngineConfig,
  GraphNode,
  IngestLogEntry,
  IngestLogInput,
  Link,
  OrgPage,
  OrgPageInput,
  PageFilters,
  PageVersion,
  RawData,
  SearchOpts,
  SearchResult,
  StaleChunkRow,
  TimelineEntry,
  TimelineInput,
  TimelineOpts,
} from "./types.ts";
import { RoamBrainError } from "./types.ts";

const DEFAULT_DB_PATH = resolve(homedir(), ".config/roambrain/brain.pglite");

export interface PgliteEngineDeps {
  /** Read-only org-roam.db reader for graph + tags lookups. Optional in tests. */
  orgRoam?: OrgRoamReader;
}

/** Subset of OrgRoamDb we actually call. Concrete impl lives in org-roam-db.ts. */
export interface OrgRoamReader {
  getLinks(id: string): Promise<Link[]>;
  getBacklinks(id: string): Promise<Link[]>;
  traverseGraph(id: string, depth: number): Promise<GraphNode[]>;
  getBacklinkCounts(ids: string[]): Promise<Map<string, number>>;
  findOrphans(): Promise<Array<{ id: string; title: string }>>;
}

export class PgliteEngine implements BrainEngine {
  readonly kind = "pglite" as const;

  private pg!: PGlite;
  private orgRoam?: OrgRoamReader;

  constructor(deps: PgliteEngineDeps = {}) {
    this.orgRoam = deps.orgRoam;
  }

  // --- Lifecycle ---

  async connect(config: EngineConfig): Promise<void> {
    const dataDir = config.database_path ?? DEFAULT_DB_PATH;
    this.pg = new PGlite({ dataDir, extensions: { vector } });
    await this.pg.waitReady;
  }

  async disconnect(): Promise<void> {
    if (this.pg) await this.pg.close();
  }

  async initSchema(): Promise<void> {
    await this.pg.exec(schemaSql);
  }

  // --- Pages ---

  async getPage(id: string): Promise<OrgPage | null> {
    const r = await this.pg.query<{
      id: string; file: string; title: string;
      compiled_truth: string; timeline: string;
      properties: Record<string, string>;
      updated_at: Date;
    }>(
      `SELECT id, file, title, compiled_truth, timeline, properties, updated_at
       FROM pages WHERE id = $1`,
      [id],
    );
    if (r.rows.length === 0) return null;
    const row = r.rows[0]!;
    const tags = await this.getTags(id);
    return { ...row, tags };
  }

  async putPage(input: OrgPageInput): Promise<OrgPage> {
    const id = input.id ?? generateOrgRoamId();
    const file = (input.properties?.FILE) ?? "";
    if (!file) {
      throw new RoamBrainError(
        "Cannot index page",
        "putPage requires properties.FILE (absolute path to the .org file)",
        "Pass the file path in `properties.FILE` so the brain can re-read it later",
      );
    }
    const props = input.properties ?? {};
    const properties = { ...props };
    delete (properties as Record<string, unknown>).FILE;

    await this.pg.query(
      `INSERT INTO pages (id, file, title, compiled_truth, timeline, properties, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET
         file = EXCLUDED.file,
         title = EXCLUDED.title,
         compiled_truth = EXCLUDED.compiled_truth,
         timeline = EXCLUDED.timeline,
         properties = EXCLUDED.properties,
         updated_at = now()`,
      [id, file, input.title, input.compiled_truth, input.timeline ?? "", JSON.stringify(properties)],
    );

    if (input.tags) await this.replaceTags(id, input.tags);

    const page = await this.getPage(id);
    if (!page) throw new Error(`putPage: row vanished after upsert (id=${id})`);
    return page;
  }

  async deletePage(id: string): Promise<void> {
    await this.pg.query(`DELETE FROM pages WHERE id = $1`, [id]);
  }

  async listPages(filters: PageFilters = {}): Promise<OrgPage[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters.tag) {
      params.push(filters.tag);
      where.push(`id IN (SELECT page_id FROM page_tags WHERE tag = $${params.length})`);
    }
    if (filters.updated_after) {
      params.push(filters.updated_after);
      where.push(`updated_at > $${params.length}::timestamptz`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const limit = Math.min(filters.limit ?? 100, 100_000);
    const offset = filters.offset ?? 0;
    params.push(limit, offset);

    const r = await this.pg.query<{
      id: string; file: string; title: string;
      compiled_truth: string; timeline: string;
      properties: Record<string, string>;
      updated_at: Date;
    }>(
      `SELECT id, file, title, compiled_truth, timeline, properties, updated_at
       FROM pages
       ${whereSql}
       ORDER BY updated_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    if (r.rows.length === 0) return [];
    const ids = r.rows.map((row) => row.id);
    const tagsByPage = await this.tagsForIds(ids);
    return r.rows.map((row) => ({ ...row, tags: tagsByPage.get(row.id) ?? [] }));
  }

  async getAllIds(): Promise<Set<string>> {
    const r = await this.pg.query<{ id: string }>(`SELECT id FROM pages`);
    return new Set(r.rows.map((row) => row.id));
  }

  // --- Search ---

  async searchKeyword(query: string, opts: SearchOpts = {}): Promise<SearchResult[]> {
    const limit = clampLimit(opts.limit);
    const params: unknown[] = [query];
    const filters: string[] = [];
    if (opts.tag) {
      params.push(opts.tag);
      filters.push(`p.id IN (SELECT page_id FROM page_tags WHERE tag = $${params.length})`);
    }
    if (opts.exclude_ids && opts.exclude_ids.length > 0) {
      const start = params.length + 1;
      const placeholders = opts.exclude_ids.map((_, i) => `$${start + i}`).join(",");
      params.push(...opts.exclude_ids);
      filters.push(`p.id NOT IN (${placeholders})`);
    }
    const whereExtra = filters.length > 0 ? ` AND ${filters.join(" AND ")}` : "";
    params.push(limit);
    const r = await this.pg.query<KeywordRow>(
      `SELECT c.id AS chunk_id, c.page_id, p.title, c.chunk_text, c.chunk_source, c.chunk_index,
              ts_rank(c.search_vector, plainto_tsquery('english', $1)) AS score
         FROM content_chunks c
         JOIN pages p ON p.id = c.page_id
        WHERE c.search_vector @@ plainto_tsquery('english', $1)${whereExtra}
        ORDER BY score DESC
        LIMIT $${params.length}`,
      params,
    );
    return r.rows.map((row) => ({
      page_id: row.page_id,
      title: row.title,
      chunk_text: row.chunk_text,
      chunk_source: row.chunk_source,
      chunk_id: row.chunk_id,
      chunk_index: row.chunk_index,
      score: Number(row.score),
      stale: false,
    }));
  }

  async searchVector(embedding: Float32Array, opts: SearchOpts = {}): Promise<SearchResult[]> {
    const limit = clampLimit(opts.limit);
    const lit = "[" + Array.from(embedding).join(",") + "]";
    const params: unknown[] = [lit];
    const filters: string[] = [`c.embedding IS NOT NULL`];
    if (opts.tag) {
      params.push(opts.tag);
      filters.push(`p.id IN (SELECT page_id FROM page_tags WHERE tag = $${params.length})`);
    }
    if (opts.exclude_ids && opts.exclude_ids.length > 0) {
      const start = params.length + 1;
      const placeholders = opts.exclude_ids.map((_, i) => `$${start + i}`).join(",");
      params.push(...opts.exclude_ids);
      filters.push(`p.id NOT IN (${placeholders})`);
    }
    params.push(limit);
    const r = await this.pg.query<VectorRow>(
      `SELECT c.id AS chunk_id, c.page_id, p.title, c.chunk_text, c.chunk_source, c.chunk_index,
              1 - (c.embedding <=> $1::vector) AS score
         FROM content_chunks c
         JOIN pages p ON p.id = c.page_id
        WHERE ${filters.join(" AND ")}
        ORDER BY c.embedding <=> $1::vector
        LIMIT $${params.length}`,
      params,
    );
    return r.rows.map((row) => ({
      page_id: row.page_id,
      title: row.title,
      chunk_text: row.chunk_text,
      chunk_source: row.chunk_source,
      chunk_id: row.chunk_id,
      chunk_index: row.chunk_index,
      score: Number(row.score),
      stale: false,
    }));
  }

  async getEmbeddingsByChunkIds(ids: number[]): Promise<Map<number, Float32Array>> {
    const out = new Map<number, Float32Array>();
    if (ids.length === 0) return out;
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
    const r = await this.pg.query<{ id: number; embedding: string | null }>(
      `SELECT id, embedding::text AS embedding
         FROM content_chunks
        WHERE id IN (${placeholders}) AND embedding IS NOT NULL`,
      ids,
    );
    for (const row of r.rows) {
      if (row.embedding) out.set(row.id, parseVectorLiteral(row.embedding));
    }
    return out;
  }

  // --- Chunks ---

  async upsertChunks(pageId: string, chunks: ChunkInput[]): Promise<void> {
    if (chunks.length === 0) return;
    for (const c of chunks) {
      await this.pg.query(
        `INSERT INTO content_chunks
           (page_id, chunk_index, chunk_text, chunk_source, model, token_count, embedded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (page_id, chunk_index) DO UPDATE SET
           chunk_text   = EXCLUDED.chunk_text,
           chunk_source = EXCLUDED.chunk_source,
           model        = EXCLUDED.model,
           token_count  = EXCLUDED.token_count,
           embedded_at  = EXCLUDED.embedded_at`,
        [
          pageId,
          c.chunk_index,
          c.chunk_text,
          c.chunk_source,
          c.model ?? "text-embedding-3-large",
          c.token_count ?? null,
          c.embedding ? new Date() : null,
        ],
      );
      // Embedding written separately to keep the column types simple — pgvector
      // accepts a textual literal `[a,b,c]` we build from the Float32Array.
      if (c.embedding) {
        const lit = "[" + Array.from(c.embedding).join(",") + "]";
        await this.pg.query(
          `UPDATE content_chunks SET embedding = $1::vector
            WHERE page_id = $2 AND chunk_index = $3`,
          [lit, pageId, c.chunk_index],
        );
      }
    }
  }

  async getChunks(pageId: string): Promise<Chunk[]> {
    const r = await this.pg.query<{
      id: number; page_id: string; chunk_index: number; chunk_text: string;
      chunk_source: "compiled_truth" | "timeline";
      embedding: string | null; model: string;
      token_count: number | null; embedded_at: Date | null;
    }>(
      `SELECT id, page_id, chunk_index, chunk_text, chunk_source,
              embedding::text AS embedding, model, token_count, embedded_at
       FROM content_chunks
       WHERE page_id = $1
       ORDER BY chunk_index`,
      [pageId],
    );
    return r.rows.map((row) => ({
      ...row,
      embedding: row.embedding ? parseVectorLiteral(row.embedding) : null,
    }));
  }

  async countStaleChunks(): Promise<number> {
    const r = await this.pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM content_chunks WHERE embedded_at IS NULL`,
    );
    return r.rows[0]?.n ?? 0;
  }

  async listStaleChunks(): Promise<StaleChunkRow[]> {
    const r = await this.pg.query<StaleChunkRow>(
      `SELECT page_id, chunk_index, chunk_text, chunk_source, model, token_count
       FROM content_chunks
       WHERE embedded_at IS NULL
       LIMIT 100000`,
    );
    return r.rows;
  }

  async deleteChunks(pageId: string): Promise<void> {
    await this.pg.query(`DELETE FROM content_chunks WHERE page_id = $1`, [pageId]);
  }

  // --- Tags ---

  async addTag(id: string, tag: string): Promise<void> {
    await this.pg.query(
      `INSERT INTO page_tags (page_id, tag) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [id, tag],
    );
  }

  async removeTag(id: string, tag: string): Promise<void> {
    await this.pg.query(`DELETE FROM page_tags WHERE page_id = $1 AND tag = $2`, [id, tag]);
  }

  async getTags(id: string): Promise<string[]> {
    const r = await this.pg.query<{ tag: string }>(
      `SELECT tag FROM page_tags WHERE page_id = $1 ORDER BY tag`,
      [id],
    );
    return r.rows.map((row) => row.tag);
  }

  private async replaceTags(id: string, tags: string[]): Promise<void> {
    await this.pg.query(`DELETE FROM page_tags WHERE page_id = $1`, [id]);
    for (const t of tags) await this.addTag(id, t);
  }

  private async tagsForIds(ids: string[]): Promise<Map<string, string[]>> {
    if (ids.length === 0) return new Map();
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
    const r = await this.pg.query<{ page_id: string; tag: string }>(
      `SELECT page_id, tag FROM page_tags WHERE page_id IN (${placeholders}) ORDER BY page_id, tag`,
      ids,
    );
    const out = new Map<string, string[]>();
    for (const row of r.rows) {
      const list = out.get(row.page_id) ?? [];
      list.push(row.tag);
      out.set(row.page_id, list);
    }
    return out;
  }

  // --- Links (read delegated to org-roam.db; writes via Emacs only) ---

  async addLink(_from: string, _to: string, _context?: string): Promise<void> {
    throw new RoamBrainError(
      "Link writes go through Emacs",
      "RoamBrain doesn't write to org-roam.db directly",
      "Insert an [[id:...]] link in the source .org file via Emacs and call syncBrain",
    );
  }
  async removeLink(_from: string, _to: string): Promise<void> {
    throw new RoamBrainError(
      "Link writes go through Emacs",
      "RoamBrain doesn't write to org-roam.db directly",
      "Remove the [[id:...]] link in the source .org file via Emacs and call syncBrain",
    );
  }

  async getLinks(id: string): Promise<Link[]> {
    return this.requireOrgRoam().getLinks(id);
  }
  async getBacklinks(id: string): Promise<Link[]> {
    return this.requireOrgRoam().getBacklinks(id);
  }
  async traverseGraph(id: string, depth = 2): Promise<GraphNode[]> {
    return this.requireOrgRoam().traverseGraph(id, depth);
  }
  async getBacklinkCounts(ids: string[]): Promise<Map<string, number>> {
    return this.requireOrgRoam().getBacklinkCounts(ids);
  }
  async findOrphanPages(): Promise<Array<{ id: string; title: string }>> {
    return this.requireOrgRoam().findOrphans();
  }

  private requireOrgRoam(): OrgRoamReader {
    if (!this.orgRoam) {
      throw new RoamBrainError(
        "org-roam.db not configured",
        "Engine constructed without an OrgRoamReader",
        "Pass `{ orgRoam: new OrgRoamDb(path) }` to PgliteEngine",
      );
    }
    return this.orgRoam;
  }

  // --- Timeline ---

  async addTimelineEntry(id: string, entry: TimelineInput): Promise<void> {
    await this.pg.query(
      `INSERT INTO timeline_entries (page_id, date, source, summary, detail)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (page_id, date, summary) DO NOTHING`,
      [id, entry.date, entry.source ?? "", entry.summary, entry.detail ?? ""],
    );
  }

  async getTimeline(id: string, opts: TimelineOpts = {}): Promise<TimelineEntry[]> {
    const where: string[] = [`page_id = $1`];
    const params: unknown[] = [id];
    if (opts.after) { params.push(opts.after); where.push(`date > $${params.length}`); }
    if (opts.before) { params.push(opts.before); where.push(`date < $${params.length}`); }
    const limit = opts.limit ?? 1000;
    params.push(limit);
    const r = await this.pg.query<TimelineEntry>(
      `SELECT id, page_id, date, source, summary, detail, created_at
       FROM timeline_entries
       WHERE ${where.join(" AND ")}
       ORDER BY date DESC
       LIMIT $${params.length}`,
      params,
    );
    return r.rows;
  }

  // --- Raw data ---

  async putRawData(id: string, source: string, data: object): Promise<void> {
    await this.pg.query(
      `INSERT INTO raw_data (page_id, source, data, fetched_at)
       VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (page_id, source) DO UPDATE SET
         data = EXCLUDED.data,
         fetched_at = now()`,
      [id, source, JSON.stringify(data)],
    );
  }

  async getRawData(id: string, source?: string): Promise<RawData[]> {
    if (source) {
      const r = await this.pg.query<RawData>(
        `SELECT source, data, fetched_at FROM raw_data WHERE page_id = $1 AND source = $2`,
        [id, source],
      );
      return r.rows;
    }
    const r = await this.pg.query<RawData>(
      `SELECT source, data, fetched_at FROM raw_data WHERE page_id = $1 ORDER BY source`,
      [id],
    );
    return r.rows;
  }

  // --- Versions ---

  async createVersion(id: string): Promise<PageVersion> {
    const page = await this.getPage(id);
    if (!page) throw new RoamBrainError("Page not found", `id=${id}`, "Insert the page first");
    const r = await this.pg.query<PageVersion>(
      `INSERT INTO page_versions (page_id, compiled_truth, properties)
       VALUES ($1, $2, $3::jsonb)
       RETURNING id, page_id, compiled_truth, snapshot_at`,
      [id, page.compiled_truth, JSON.stringify(page.properties)],
    );
    return r.rows[0]!;
  }

  async getVersions(id: string): Promise<PageVersion[]> {
    const r = await this.pg.query<PageVersion>(
      `SELECT id, page_id, compiled_truth, snapshot_at
       FROM page_versions WHERE page_id = $1 ORDER BY snapshot_at DESC`,
      [id],
    );
    return r.rows;
  }

  async revertToVersion(id: string, versionId: number): Promise<void> {
    const r = await this.pg.query<{ compiled_truth: string }>(
      `SELECT compiled_truth FROM page_versions WHERE id = $1 AND page_id = $2`,
      [versionId, id],
    );
    if (r.rows.length === 0) {
      throw new RoamBrainError("Version not found", `id=${id} version=${versionId}`, "Use getVersions(id) to list");
    }
    await this.pg.query(
      `UPDATE pages SET compiled_truth = $1, updated_at = now() WHERE id = $2`,
      [r.rows[0]!.compiled_truth, id],
    );
  }

  // --- Stats / health ---

  async getStats(): Promise<BrainStats> {
    const r = await this.pg.query<{
      page_count: number; chunk_count: number; embedded_count: number;
      tag_count: number; timeline_entry_count: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM pages)             AS page_count,
         (SELECT count(*)::int FROM content_chunks)    AS chunk_count,
         (SELECT count(*)::int FROM content_chunks
            WHERE embedded_at IS NOT NULL)             AS embedded_count,
         (SELECT count(DISTINCT tag)::int FROM page_tags) AS tag_count,
         (SELECT count(*)::int FROM timeline_entries)  AS timeline_entry_count`,
    );
    const base = r.rows[0]!;
    let link_count = 0;
    if (this.orgRoam) {
      const ids = await this.getAllIds();
      const counts = await this.orgRoam.getBacklinkCounts([...ids]);
      for (const v of counts.values()) link_count += v;
    }
    return { ...base, link_count };
  }

  async getHealth(): Promise<BrainHealth> {
    const stats = await this.getStats();
    const embed_coverage = stats.chunk_count > 0
      ? stats.embedded_count / stats.chunk_count
      : 1;
    const orphans = this.orgRoam ? await this.orgRoam.findOrphans() : [];
    return {
      page_count: stats.page_count,
      embed_coverage,
      stale_pages: 0,
      orphan_pages: orphans.length,
      missing_embeddings: stats.chunk_count - stats.embedded_count,
      dead_links: 0,
      brain_score: Math.round(embed_coverage * 100),
    };
  }

  // --- Ingest log ---

  async logIngest(entry: IngestLogInput): Promise<void> {
    await this.pg.query(
      `INSERT INTO ingest_log (source_type, source_ref, pages_updated, summary)
       VALUES ($1, $2, $3, $4)`,
      [entry.source_type, entry.source_ref, entry.pages_updated, entry.summary],
    );
  }

  async getIngestLog(opts: { limit?: number } = {}): Promise<IngestLogEntry[]> {
    const limit = opts.limit ?? 50;
    const r = await this.pg.query<IngestLogEntry>(
      `SELECT id, source_type, source_ref, pages_updated, summary, created_at
       FROM ingest_log ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return r.rows;
  }

  // --- Sync ---

  async syncBrain(): Promise<{ synced: number; deleted: number }> {
    // Stub: real implementation lives in src/core/sync.ts (separate TODO).
    // Here we just touch updated_at so callers can test the wire.
    return { synced: 0, deleted: 0 };
  }

  // --- Config ---

  async getConfig(key: string): Promise<string | null> {
    const r = await this.pg.query<{ value: string }>(
      `SELECT value FROM config WHERE key = $1`,
      [key],
    );
    return r.rows[0]?.value ?? null;
  }

  async setConfig(key: string, value: string): Promise<void> {
    await this.pg.query(
      `INSERT INTO config (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value],
    );
  }

  // --- Raw SQL ---

  async executeRaw<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.pg.query<T>(sql, params);
    return r.rows;
  }
}

// --- Helpers ---

interface KeywordRow {
  chunk_id: number;
  page_id: string;
  title: string;
  chunk_text: string;
  chunk_source: "compiled_truth" | "timeline";
  chunk_index: number;
  score: number;
}
type VectorRow = KeywordRow;

function parseVectorLiteral(s: string): Float32Array {
  // pgvector's text format is `[a,b,c]`. Trim brackets, split on commas.
  const trimmed = s.startsWith("[") ? s.slice(1, -1) : s;
  if (!trimmed) return new Float32Array(0);
  const parts = trimmed.split(",");
  const out = new Float32Array(parts.length);
  for (let i = 0; i < parts.length; i++) out[i] = Number(parts[i]);
  return out;
}

function generateOrgRoamId(): string {
  // Org Roam timestamp ID: YYYYMMDDTHHMMSS.uuuuuu
  const d = new Date();
  const pad = (n: number, w = 2) => n.toString().padStart(w, "0");
  const stamp =
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) + pad(d.getDate()) + "T" +
    pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + "." +
    pad(d.getMilliseconds() * 1000 + Math.floor(Math.random() * 1000), 6);
  return stamp;
}
