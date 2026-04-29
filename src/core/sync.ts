// Walk org-roam.db, parse each file via Emacs, upsert page metadata, chunk +
// embed compiled_truth/timeline, and prune pages that no longer exist on the
// graph side. Embedding is skipped silently when no embedFn is provided
// (callers wire OpenAI in based on environment).

import type { BrainEngine } from "./engine.ts";
import type { OrgRoamDb } from "./org-roam-db.ts";
import type { EmacsClient } from "./emacs.ts";
import { parseOrgFile } from "./org.ts";
import { chunkOrgText } from "./chunkers/org.ts";

export interface SyncResult {
  scanned: number;
  skipped: number;
  upserted: number;
  chunks: number;
  embedded: number;
  deleted: number;
  errors: Array<{ id: string; file: string; error: string }>;
}

export interface SyncOptions {
  /** Embedder. Receives chunk texts, returns parallel Float32Array list. */
  embedFn?: (texts: string[]) => Promise<Float32Array[]>;
  /** Re-embed even when chunk text is unchanged. Default false. */
  reembed?: boolean;
  /** Per-page progress callback. `skipped` indicates the page was hash-unchanged. */
  onPage?: (info: { i: number; n: number; id: string; file: string; skipped: boolean }) => void;
  /** Refuse pages with more than this many chunks (safety). Default 5000. */
  maxChunksPerPage?: number;
}

export async function runSync(
  engine: BrainEngine,
  emacs: EmacsClient,
  orgRoam: OrgRoamDb,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const result: SyncResult = { scanned: 0, skipped: 0, upserted: 0, chunks: 0, embedded: 0, deleted: 0, errors: [] };
  const maxChunks = opts.maxChunksPerPage ?? 5000;

  const nodes = await orgRoam.listFileNodes();
  result.scanned = nodes.length;

  const storedHashes = await engine.getPageHashes();
  const liveIds = new Set<string>();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    liveIds.add(n.id);

    const unchanged = !opts.reembed && storedHashes.get(n.id) === n.hash;
    if (unchanged) {
      result.skipped++;
      opts.onPage?.({ i: i + 1, n: nodes.length, id: n.id, file: n.file, skipped: true });
      continue;
    }
    opts.onPage?.({ i: i + 1, n: nodes.length, id: n.id, file: n.file, skipped: false });

    try {
      const parsed = await parseOrgFile(emacs, n.file);
      const properties = { ...parsed.properties, FILE: n.file, ID: n.id };

      await engine.putPage({
        id: n.id,
        title: parsed.title || n.title,
        tags: parsed.tags,
        properties,
        compiled_truth: parsed.compiled_truth,
        timeline: parsed.timeline,
        content_hash: n.hash,
      });
      result.upserted++;

      // Chunk compiled_truth + timeline separately so chunk_source is meaningful.
      const truthChunks = chunkOrgText(parsed.compiled_truth).map((c, idx) => ({
        chunk_index: idx,
        chunk_text: c.text,
        chunk_source: "compiled_truth" as const,
      }));
      const timelineChunks = chunkOrgText(parsed.timeline).map((c, idx) => ({
        chunk_index: truthChunks.length + idx,
        chunk_text: c.text,
        chunk_source: "timeline" as const,
      }));
      const allChunks = [...truthChunks, ...timelineChunks];
      if (allChunks.length > maxChunks) {
        throw new Error(`page produced ${allChunks.length} chunks (cap ${maxChunks})`);
      }

      // Compare against existing chunks; only re-embed when text changed (or reembed forced).
      let embeddings: (Float32Array | undefined)[] = new Array(allChunks.length).fill(undefined);
      if (opts.embedFn && allChunks.length > 0) {
        const existing = await engine.getChunks(n.id);
        const existingByText = new Map<string, Float32Array | null>();
        for (const ec of existing) existingByText.set(ec.chunk_text, ec.embedding);

        const toEmbedIdx: number[] = [];
        for (let j = 0; j < allChunks.length; j++) {
          const ec = !opts.reembed ? existingByText.get(allChunks[j]!.chunk_text) : undefined;
          if (ec && ec.length > 0) embeddings[j] = ec;
          else toEmbedIdx.push(j);
        }
        if (toEmbedIdx.length > 0) {
          const fresh = await opts.embedFn(toEmbedIdx.map((j) => allChunks[j]!.chunk_text));
          for (let k = 0; k < toEmbedIdx.length; k++) embeddings[toEmbedIdx[k]!] = fresh[k];
          result.embedded += toEmbedIdx.length;
        }
      }

      // Replace this page's chunks with the freshly computed set.
      await engine.deleteChunks(n.id);
      await engine.upsertChunks(
        n.id,
        allChunks.map((c, j) => ({ ...c, ...(embeddings[j] ? { embedding: embeddings[j]! } : {}) })),
      );
      result.chunks += allChunks.length;
    } catch (e) {
      result.errors.push({ id: n.id, file: n.file, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Prune pages that no longer exist on the org-roam side.
  const indexed = await engine.getAllIds();
  for (const id of indexed) {
    if (!liveIds.has(id)) {
      await engine.deletePage(id);
      result.deleted++;
    }
  }

  await engine.logIngest({
    source_type: "sync",
    source_ref: "org-roam",
    pages_updated: [...liveIds],
    summary: `scanned=${result.scanned} skipped=${result.skipped} upserted=${result.upserted} chunks=${result.chunks} embedded=${result.embedded} deleted=${result.deleted} errors=${result.errors.length}`,
  });

  return result;
}
