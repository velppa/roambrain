-- RoamBrain PGLite schema. Pages are keyed by Org Roam :ID: (TEXT).
-- Links + filetags primarily live in org-roam.db (SQLite, managed by Emacs);
-- we mirror tags here for fast filtering without round-tripping. Page bodies
-- live on disk as .org files — these tables index them.

CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- pages: indexed metadata for each Org Roam node
-- ============================================================
CREATE TABLE IF NOT EXISTS pages (
  id             TEXT PRIMARY KEY,
  file           TEXT NOT NULL,
  title          TEXT NOT NULL,
  compiled_truth TEXT NOT NULL DEFAULT '',
  timeline       TEXT NOT NULL DEFAULT '',
  properties     JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_hash   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pages_file ON pages(file);
CREATE INDEX IF NOT EXISTS idx_pages_updated_at_desc ON pages(updated_at DESC);

-- ============================================================
-- page_tags: mirror of #+filetags: per page (cached from org-roam.db)
-- ============================================================
CREATE TABLE IF NOT EXISTS page_tags (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  PRIMARY KEY (page_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_page_tags_tag ON page_tags(tag);

-- ============================================================
-- content_chunks: chunked content + embeddings
-- ============================================================
CREATE TABLE IF NOT EXISTS content_chunks (
  id            SERIAL PRIMARY KEY,
  page_id       TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  chunk_index   INTEGER NOT NULL,
  chunk_text    TEXT NOT NULL,
  chunk_source  TEXT NOT NULL DEFAULT 'compiled_truth'
                CHECK (chunk_source IN ('compiled_truth','timeline')),
  embedding     vector(1536),
  model         TEXT NOT NULL DEFAULT 'text-embedding-3-large',
  token_count   INTEGER,
  embedded_at   TIMESTAMPTZ,
  search_vector TSVECTOR,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_page_index ON content_chunks(page_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_chunks_page ON content_chunks(page_id);
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_chunks_fts ON content_chunks USING GIN (search_vector);

-- search_vector is maintained by trigger so callers don't have to.
CREATE OR REPLACE FUNCTION content_chunks_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := to_tsvector('english', coalesce(NEW.chunk_text, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_content_chunks_search_vector ON content_chunks;
CREATE TRIGGER trg_content_chunks_search_vector
BEFORE INSERT OR UPDATE OF chunk_text ON content_chunks
FOR EACH ROW EXECUTE FUNCTION content_chunks_search_vector_update();

-- ============================================================
-- timeline_entries: structured timeline rows derived from `* Changelog`
-- ============================================================
CREATE TABLE IF NOT EXISTS timeline_entries (
  id         SERIAL PRIMARY KEY,
  page_id    TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT '',
  summary    TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT timeline_unique UNIQUE (page_id, date, summary)
);

CREATE INDEX IF NOT EXISTS idx_timeline_page ON timeline_entries(page_id);
CREATE INDEX IF NOT EXISTS idx_timeline_date ON timeline_entries(date);

-- ============================================================
-- raw_data: sidecar JSON from external APIs
-- ============================================================
CREATE TABLE IF NOT EXISTS raw_data (
  page_id    TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  source     TEXT NOT NULL,
  data       JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, source)
);

-- ============================================================
-- page_versions: snapshot history of compiled_truth
-- ============================================================
CREATE TABLE IF NOT EXISTS page_versions (
  id             SERIAL PRIMARY KEY,
  page_id        TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  compiled_truth TEXT NOT NULL,
  properties     JSONB NOT NULL DEFAULT '{}'::jsonb,
  snapshot_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_versions_page ON page_versions(page_id, snapshot_at DESC);

-- ============================================================
-- ingest_log: audit trail
-- ============================================================
CREATE TABLE IF NOT EXISTS ingest_log (
  id            SERIAL PRIMARY KEY,
  source_type   TEXT NOT NULL,
  source_ref    TEXT NOT NULL,
  pages_updated TEXT[] NOT NULL DEFAULT '{}',
  summary       TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ingest_log_created_at ON ingest_log(created_at DESC);

-- ============================================================
-- config: brain-level key/value store
-- ============================================================
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
