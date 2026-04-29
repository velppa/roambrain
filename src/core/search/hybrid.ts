// Hybrid search: keyword + vector → RRF fusion → cosine re-score → backlink
// boost → 4-layer dedup. Adapted from gbrain. Stripped: query expansion,
// intent-based detail levels, two-pass code-edge expansion, language/symbol
// filters, source_id (RoamBrain is single-source).

import type { BrainEngine } from "../engine.ts";
import { MAX_SEARCH_LIMIT } from "../engine.ts";
import type { SearchOpts, SearchResult } from "../types.ts";
import { embed } from "../embedding.ts";
import { dedupResults, type DedupOpts } from "./dedup.ts";

const RRF_K = 60;
const COMPILED_TRUTH_BOOST = 2.0;
const BACKLINK_BOOST_COEF = 0.05;

export interface HybridSearchOpts extends SearchOpts {
  /** Override RRF K (default 60). Lower → top-ranked results dominate more. */
  rrfK?: number;
  /** Forwarded to dedupResults. */
  dedupOpts?: DedupOpts;
}

export async function hybridSearch(
  engine: BrainEngine,
  query: string,
  opts: HybridSearchOpts = {},
): Promise<SearchResult[]> {
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;
  const innerLimit = Math.min(limit * 2, MAX_SEARCH_LIMIT);
  const inner: SearchOpts = {
    limit: innerLimit,
    tag: opts.tag,
    exclude_ids: opts.exclude_ids,
  };

  const keywordResults = await engine.searchKeyword(query, inner);

  // No OPENAI key → keyword-only path with backlink boost.
  if (!process.env.OPENAI_API_KEY) {
    if (keywordResults.length > 0) {
      try {
        const ids = [...new Set(keywordResults.map((r) => r.page_id))];
        const counts = await engine.getBacklinkCounts(ids);
        applyBacklinkBoost(keywordResults, counts);
        keywordResults.sort((a, b) => b.score - a.score);
      } catch {
        // boost failure is non-fatal
      }
    }
    return dedupResults(keywordResults, opts.dedupOpts).slice(offset, offset + limit);
  }

  let queryEmbedding: Float32Array | null = null;
  let vectorResults: SearchResult[] = [];
  try {
    queryEmbedding = await embed(query);
    vectorResults = await engine.searchVector(queryEmbedding, inner);
  } catch {
    // embedding/vector failure → keyword-only fallback
  }

  if (vectorResults.length === 0 && keywordResults.length === 0) return [];

  let fused = rrfFusion([vectorResults, keywordResults], opts.rrfK ?? RRF_K);

  if (queryEmbedding) {
    fused = await cosineReScore(engine, fused, queryEmbedding);
  }

  if (fused.length > 0) {
    try {
      const ids = [...new Set(fused.map((r) => r.page_id))];
      const counts = await engine.getBacklinkCounts(ids);
      applyBacklinkBoost(fused, counts);
      fused.sort((a, b) => b.score - a.score);
    } catch {
      // boost failure is non-fatal
    }
  }

  return dedupResults(fused, opts.dedupOpts).slice(offset, offset + limit);
}

/**
 * Reciprocal Rank Fusion. Score = Σ 1/(k+rank). After accumulation we
 * normalize to 0–1 and apply the compiled_truth boost so it survives
 * cosine re-scoring.
 */
export function rrfFusion(lists: SearchResult[][], k: number): SearchResult[] {
  const scores = new Map<string, { result: SearchResult; score: number }>();
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const r = list[rank]!;
      const key = `${r.page_id}:${r.chunk_id}`;
      const rrf = 1 / (k + rank);
      const existing = scores.get(key);
      if (existing) existing.score += rrf;
      else scores.set(key, { result: r, score: rrf });
    }
  }
  const entries = [...scores.values()];
  if (entries.length === 0) return [];
  const max = Math.max(...entries.map((e) => e.score));
  for (const e of entries) {
    e.score = max > 0 ? e.score / max : 0;
    if (e.result.chunk_source === "compiled_truth") e.score *= COMPILED_TRUTH_BOOST;
  }
  return entries
    .sort((a, b) => b.score - a.score)
    .map(({ result, score }) => ({ ...result, score }));
}

async function cosineReScore(
  engine: BrainEngine,
  results: SearchResult[],
  queryEmbedding: Float32Array,
): Promise<SearchResult[]> {
  const ids = results.map((r) => r.chunk_id).filter((id) => id != null);
  if (ids.length === 0) return results;
  let embMap: Map<number, Float32Array>;
  try {
    embMap = await engine.getEmbeddingsByChunkIds(ids);
  } catch {
    return results;
  }
  if (embMap.size === 0) return results;

  const maxRrf = Math.max(...results.map((r) => r.score));
  return results.map((r) => {
    const e = embMap.get(r.chunk_id);
    if (!e) return r;
    const cos = cosineSimilarity(queryEmbedding, e);
    const norm = maxRrf > 0 ? r.score / maxRrf : 0;
    return { ...r, score: 0.7 * norm + 0.3 * cos };
  }).sort((a, b) => b.score - a.score);
}

export function applyBacklinkBoost(results: SearchResult[], counts: Map<string, number>): void {
  for (const r of results) {
    const c = counts.get(r.page_id) ?? 0;
    if (c > 0) r.score *= 1.0 + BACKLINK_BOOST_COEF * Math.log(1 + c);
  }
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}
