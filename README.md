# RoamBrain

Org Roam + Emacs personal knowledge brain with hybrid RAG search.

Loose fork of [GBrain](https://github.com/garrytan/gbrain) by Garry Tan,
focused on Org Mode files managed by Org Roam, driven via `emacsclient`.

## Status

Pre-alpha. Skeleton only — see `plan.org` (in the workspace at
`~/Sync/260429--roambrain/`) for the current roadmap.

## Goals

- Use Org Mode files managed by Org Roam as source of truth.
- Drive Emacs via `emacsclient` for read/write/sync.
- Query `org-roam.db` (SQLite) for the note graph.
- Keep PGLite-backed chunks + embeddings for hybrid search.
- Same public MCP interface as GBrain (21 tools) so external tools
  connect unchanged.

## Build

```sh
bun install
bun run build      # → bin/roambrain
```

## Layout

```
src/
  cli.ts           entrypoint
  core/            engine, chunkers, search, embedding, storage
  mcp/             MCP stdio server + tool defs
  commands/        CLI subcommands
skills/            fat markdown skill files
templates/         Org page templates per type
test/              tests
scripts/           build / dev helpers
```

## License

MIT. See `LICENSE`. Derived from GBrain, also MIT.
