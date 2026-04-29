// Org-aware splitter. Pre-splits a body on heading boundaries (`* `, `** `, …)
// so chunks rarely straddle a heading, then runs the recursive chunker on each
// section. Sections smaller than the target chunk size are emitted as-is.

import { chunkText, type ChunkOptions, type TextChunk } from "./recursive.ts";

const HEADING_RE = /^\*+ .+$/gm;

export function chunkOrgText(text: string, opts?: ChunkOptions): TextChunk[] {
  if (!text || text.trim().length === 0) return [];

  const sections = splitOrgSections(text);
  if (sections.length <= 1) {
    return chunkText(text, opts);
  }

  const out: TextChunk[] = [];
  let idx = 0;
  for (const section of sections) {
    const sub = chunkText(section, opts);
    for (const c of sub) out.push({ text: c.text, index: idx++ });
  }
  return out;
}

// Split on top-level (`* `) headings. Sub-headings stay attached to their
// parent section so the recursive chunker has the natural prose boundaries
// (paragraphs/sentences) to work with.
export function splitOrgSections(text: string): string[] {
  const matches: number[] = [];
  HEADING_RE.lastIndex = 0;
  for (let m = HEADING_RE.exec(text); m !== null; m = HEADING_RE.exec(text)) {
    if (m[0].startsWith("* ")) matches.push(m.index);
  }
  if (matches.length === 0) return [text];

  const sections: string[] = [];
  if (matches[0]! > 0) {
    const preamble = text.slice(0, matches[0]!).trim();
    if (preamble) sections.push(preamble);
  }
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i]!;
    const end = i + 1 < matches.length ? matches[i + 1]! : text.length;
    const section = text.slice(start, end).trim();
    if (section) sections.push(section);
  }
  return sections;
}
