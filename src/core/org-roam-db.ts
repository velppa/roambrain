// Read-only adapter over org-roam.db (SQLite, written by Emacs).
//
// Key gotcha: org-roam stores every text column as an elisp `prin1`
// representation, which means strings are wrapped in extra double quotes
// (e.g. id `"abc"`). We unwrap on read; callers see clean values.

import { Database } from "bun:sqlite";
import type { GraphNode, Link } from "./types.ts";

export interface OrgRoamDbOptions {
  /** Absolute path to org-roam.db. */
  path: string;
}

export class OrgRoamDb {
  private readonly db: Database;

  constructor(opts: OrgRoamDbOptions) {
    this.db = new Database(opts.path, { readonly: true });
  }

  close(): void {
    this.db.close();
  }

  async getLinks(id: string): Promise<Link[]> {
    const rows = this.q<{ source: string; dest: string; properties: string }>(
      `SELECT source, dest, properties
       FROM links
       WHERE source = ? AND type = '"id"'`,
    ).all(quote(id));
    return rows.map((r) => ({
      from_id: unquote(r.source),
      to_id: unquote(r.dest),
      context: extractOutline(r.properties),
    }));
  }

  async getBacklinks(id: string): Promise<Link[]> {
    const rows = this.q<{ source: string; dest: string; properties: string }>(
      `SELECT source, dest, properties
       FROM links
       WHERE dest = ? AND type = '"id"'`,
    ).all(quote(id));
    return rows.map((r) => ({
      from_id: unquote(r.source),
      to_id: unquote(r.dest),
      context: extractOutline(r.properties),
    }));
  }

  async getBacklinkCounts(ids: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (ids.length === 0) return out;
    for (const id of ids) out.set(id, 0);
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.q<{ dest: string; n: number }>(
      `SELECT dest, count(*) AS n
       FROM links
       WHERE type = '"id"' AND dest IN (${placeholders})
       GROUP BY dest`,
    ).all(...ids.map(quote));
    for (const r of rows) out.set(unquote(r.dest), r.n);
    return out;
  }

  async findOrphans(): Promise<Array<{ id: string; title: string }>> {
    // Orphan = node id that never appears as a links.dest with type='"id"'.
    const rows = this.q<{ id: string; title: string }>(
      `SELECT n.id, n.title
       FROM nodes n
       WHERE NOT EXISTS (
         SELECT 1 FROM links l
         WHERE l.type = '"id"' AND l.dest = n.id
       )`,
    ).all();
    return rows.map((r) => ({ id: unquote(r.id), title: unquote(r.title) }));
  }

  async traverseGraph(id: string, depth: number): Promise<GraphNode[]> {
    // BFS up to `depth` hops, outbound only.
    const visited = new Map<string, GraphNode>();
    let frontier = new Set<string>([id]);
    let currentDepth = 0;

    while (frontier.size > 0 && currentDepth <= depth) {
      const ids = [...frontier];
      const titlesByid = await this.titlesForIds(ids);
      const linksByid = await this.outboundLinksForIds(ids);

      for (const fid of ids) {
        if (visited.has(fid)) continue;
        visited.set(fid, {
          id: fid,
          title: titlesByid.get(fid) ?? "",
          depth: currentDepth,
          links: (linksByid.get(fid) ?? []).map((dest) => ({ to_id: dest })),
        });
      }

      const next = new Set<string>();
      if (currentDepth < depth) {
        for (const fid of ids) {
          for (const dest of linksByid.get(fid) ?? []) {
            if (!visited.has(dest)) next.add(dest);
          }
        }
      }
      frontier = next;
      currentDepth++;
    }
    return [...visited.values()];
  }

  /** Fetch titles for a set of node IDs in a single query. */
  private async titlesForIds(ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (ids.length === 0) return out;
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.q<{ id: string; title: string }>(
      `SELECT id, title FROM nodes WHERE id IN (${placeholders})`,
    ).all(...ids.map(quote));
    for (const r of rows) out.set(unquote(r.id), unquote(r.title));
    return out;
  }

  /** Fetch outbound id-links from a set of source IDs in one query. */
  private async outboundLinksForIds(ids: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (ids.length === 0) return out;
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.q<{ source: string; dest: string }>(
      `SELECT source, dest FROM links
       WHERE type = '"id"' AND source IN (${placeholders})`,
    ).all(...ids.map(quote));
    for (const r of rows) {
      const src = unquote(r.source);
      const dst = unquote(r.dest);
      const list = out.get(src) ?? [];
      list.push(dst);
      out.set(src, list);
    }
    return out;
  }

  /** Filetags for a node — joined from the tags table. */
  async getTags(id: string): Promise<string[]> {
    const rows = this.q<{ tag: string }>(
      `SELECT tag FROM tags WHERE node_id = ? ORDER BY tag`,
    ).all(quote(id));
    return rows.map((r) => unquote(r.tag));
  }

  /** Resolve a node ID to its file path (unwrapped). */
  async nodeFile(id: string): Promise<string | null> {
    const r = this.db
      .query<{ file: string }, [string]>(`SELECT file FROM nodes WHERE id = ? LIMIT 1`)
      .get(quote(id));
    return r ? unquote(r.file) : null;
  }

  private q<T>(sql: string) {
    return this.db.query<T, string[]>(sql);
  }
}

// --- Encoding helpers (org-roam stores values as elisp prin1 forms) ---

function quote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function unquote(s: string | null): string {
  if (s == null) return "";
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return s;
}

/** Pull `:outline ("a" "b")` from a links.properties plist string. */
function extractOutline(properties: string): string {
  const m = properties.match(/:outline\s+\(([^)]*)\)/);
  if (!m) return "";
  const inner = m[1]!.trim();
  if (inner === "nil" || inner === "") return "";
  // Strip leading/trailing quotes from each segment.
  return inner
    .split(/"\s+"/)
    .map((s) => s.replace(/^"/, "").replace(/"$/, ""))
    .join(" › ");
}
