// 4-layer dedup pipeline + compiled-truth guarantee. Slimmed from gbrain:
// dropped layer 3 (page-type diversity) — RoamBrain pages have no `type`.
// Replacement diversity layer enforces a chunk_source ratio so a single
// page's compiled_truth doesn't crowd out timeline hits and vice versa.
//
//   1. By page: keep top 3 chunks per page by score
//   2. By text similarity: drop Jaccard-similar chunks (>0.85)
//   3. By chunk_source: cap any single source at 60% of results
//   4. By page: cap chunks per page (default 2)
//   5. Guarantee: ensure each surviving page has ≥1 compiled_truth chunk
//      when one existed in the pre-dedup pool.

import type { SearchResult } from "../types.ts";

const COSINE_DEDUP_THRESHOLD = 0.85;
const MAX_SOURCE_RATIO = 0.6;
const MAX_PER_PAGE = 2;

export interface DedupOpts {
  cosineThreshold?: number;
  maxSourceRatio?: number;
  maxPerPage?: number;
}

export function dedupResults(results: SearchResult[], opts?: DedupOpts): SearchResult[] {
  const threshold = opts?.cosineThreshold ?? COSINE_DEDUP_THRESHOLD;
  const maxRatio = opts?.maxSourceRatio ?? MAX_SOURCE_RATIO;
  const maxPerPage = opts?.maxPerPage ?? MAX_PER_PAGE;

  const preDedup = results;
  let deduped = results;
  deduped = dedupByPage(deduped);
  deduped = dedupByTextSimilarity(deduped, threshold);
  deduped = enforceSourceDiversity(deduped, maxRatio);
  deduped = capPerPage(deduped, maxPerPage);
  deduped = guaranteeCompiledTruth(deduped, preDedup);
  return deduped;
}

function dedupByPage(results: SearchResult[]): SearchResult[] {
  const byPage = new Map<string, SearchResult[]>();
  for (const r of results) {
    const list = byPage.get(r.page_id) ?? [];
    list.push(r);
    byPage.set(r.page_id, list);
  }
  const kept: SearchResult[] = [];
  for (const chunks of byPage.values()) {
    chunks.sort((a, b) => b.score - a.score);
    kept.push(...chunks.slice(0, 3));
  }
  return kept.sort((a, b) => b.score - a.score);
}

function dedupByTextSimilarity(results: SearchResult[], threshold: number): SearchResult[] {
  const kept: SearchResult[] = [];
  for (const r of results) {
    const rWords = new Set(r.chunk_text.toLowerCase().split(/\s+/));
    let tooSimilar = false;
    for (const k of kept) {
      const kWords = new Set(k.chunk_text.toLowerCase().split(/\s+/));
      const intersection = new Set([...rWords].filter((w) => kWords.has(w)));
      const union = new Set([...rWords, ...kWords]);
      const jaccard = union.size === 0 ? 0 : intersection.size / union.size;
      if (jaccard > threshold) { tooSimilar = true; break; }
    }
    if (!tooSimilar) kept.push(r);
  }
  return kept;
}

function enforceSourceDiversity(results: SearchResult[], maxRatio: number): SearchResult[] {
  const maxPerSource = Math.max(1, Math.ceil(results.length * maxRatio));
  const counts = new Map<string, number>();
  const kept: SearchResult[] = [];
  for (const r of results) {
    const c = counts.get(r.chunk_source) ?? 0;
    if (c < maxPerSource) {
      kept.push(r);
      counts.set(r.chunk_source, c + 1);
    }
  }
  return kept;
}

function capPerPage(results: SearchResult[], maxPerPage: number): SearchResult[] {
  const counts = new Map<string, number>();
  const kept: SearchResult[] = [];
  for (const r of results) {
    const c = counts.get(r.page_id) ?? 0;
    if (c < maxPerPage) {
      kept.push(r);
      counts.set(r.page_id, c + 1);
    }
  }
  return kept;
}

function guaranteeCompiledTruth(results: SearchResult[], preDedup: SearchResult[]): SearchResult[] {
  const byPage = new Map<string, SearchResult[]>();
  for (const r of results) {
    const list = byPage.get(r.page_id) ?? [];
    list.push(r);
    byPage.set(r.page_id, list);
  }

  const output = [...results];
  for (const [pageId, pageChunks] of byPage) {
    if (pageChunks.some((c) => c.chunk_source === "compiled_truth")) continue;
    const candidate = preDedup
      .filter((r) => r.page_id === pageId && r.chunk_source === "compiled_truth")
      .sort((a, b) => b.score - a.score)[0];
    if (!candidate) continue;
    const lowestIdx = output.reduce((minIdx, r, idx) => {
      if (r.page_id !== pageId) return minIdx;
      if (minIdx === -1) return idx;
      return r.score < output[minIdx]!.score ? idx : minIdx;
    }, -1);
    if (lowestIdx !== -1) output[lowestIdx] = candidate;
  }
  return output;
}
