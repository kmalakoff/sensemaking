# sensemaking

Query a knowledge base you build with an agent: filter notes by frontmatter, then search inside them.

## The problem

When you work with an AI agent on anything substantial, you end up with a pile of small notes —
findings, decisions, sources, summaries. The pile is the point: it's how knowledge accumulates
instead of being re-derived every session.

But accumulation only pays off if it's findable. Past a couple dozen notes, an agent can't tell
which fifteen of two hundred bear on its task, so it greps blindly, swallows the whole folder into
context, or quietly rebuilds knowledge that already exists three files away.

The classification an agent adds while writing — `status`, `type`, `tags`, `source` — is what keeps
the pile navigable. `sensemaking` is the layer that acts on it, without an app running, a build
step, or you re-explaining anything.

## How it works

Every file becomes a row; every frontmatter key becomes a column. You write named SQL queries once
and run them by name.

```markdown
---
title: Ship the Q3 report
status: active
tags: [urgent, reports]
---

Notes about the report…
```

Two properties make it trustworthy:

- **Never stale.** Every query re-checks the filesystem first, re-reading only what changed. The
  SQLite cache under `.sense/` is disposable — delete it any time, the next query rebuilds it. An
  agent can trust a result without knowing when anything was last indexed.
- **Headless.** Files on disk are the only source of truth. Nothing needs to be open — not
  Obsidian, not a server, not a daemon.

## Use it

```bash
npm install -g sensemaking
cd your-notes && sense init        # writes a starter sense.config.json
```

Edit the queries to match your own frontmatter (the `$schema` line gives your editor autocomplete
and validation):

```json
{
  "$schema": "https://unpkg.com/sensemaking/schema.json",
  "version": 1,
  "scan": { "include": ["**/*.md"] },
  "queries": {
    "all": "SELECT path, title FROM docs ORDER BY path",
    "by-tag": "SELECT path, title FROM docs WHERE has(tags, ?) ORDER BY path"
  }
}
```

```
sense all                          # run a named query
sense by-tag urgent                # positional args bind to ? placeholders (count-checked)
sense query "SELECT … FROM docs"   # ad-hoc SQL for one-off questions, no config edit
sense --list                       # what queries exist
sense <name> --format json         # structured output (the default is a table)
sense status | rebuild             # cache info / delete .sense/ and re-crawl
```

Discovery walks up from your cwd git-style, so you can run `sense` from anywhere in the tree
(`--config <path>` overrides). Exit codes: `0` ok, `1` real error (SQLite's message verbatim),
`2` usage error.

The one custom SQL function is `has(field, value)`: array membership on a JSON-array field (like
`tags`), substring match on a string, always false on a missing key. Reserved columns: `path`,
`_mtime`, `_size`.

### For AI agents

```bash
npm install -g sensemaking             # the CLI
npx skills add kmalakoff/sensemaking   # the agent skill (add -g for global, -a claude-code to target)
```

The skill teaches an agent the essentials: discovery, `--list`, `--format json`, `has()`, when to
use ad-hoc `query` versus saving a named one, and when to `rebuild`.

### Optional: a background pre-warmer

`sense watch` runs the same reconcile ahead of time whenever the filesystem changes, so queries
open on an already-warm cache. It's purely an optimization — queries reconcile on open anyway, so
a missed event can never make a result wrong — and under ~1000 files you likely won't notice a
difference. It runs in the foreground and never daemonizes; process supervision belongs to the OS.
launchd and systemd examples: [WATCH.md](WATCH.md).

## Why not …

- **Obsidian (Bases/Dataview):** filters this well — but only inside the running Electron app,
  through its own view formats. There's no headless mode for queries (only Sync), so scripts and
  agents must keep the app open. `sensemaking` needs no app and speaks plain SQL. Your vault works
  unmodified either way; Obsidian stays a fine viewer for the same files.
- **RAG / semantic search:** retrieves by similarity and hopes relevance follows. That can't
  express "only active notes from this project" as a hard constraint — a `WHERE` clause can. The
  two compose rather than compete: filter first, rank later.
- **Index-on-build tools (MarkdownDB and similar):** you run an explicit index step and query the
  snapshot, which is stale the moment a file changes. `sensemaking` reconciles on every query, so
  there's no stale window by construction.
- **Note CLIs (zk and similar):** good at their own model — tags, links, full text — but they
  can't filter on arbitrary frontmatter fields, which is the whole point here.
- **grep / one-off scripts:** fine until you want named, reusable, parameterized queries with real
  AND/OR/ORDER BY — at which point you've started writing a worse query engine.

`sensemaking` is deliberately thin glue: [gray-matter](https://github.com/jonschlinkert/gray-matter)
parses, [fast-glob](https://github.com/mrmlnc/fast-glob) walks, and Node's built-in SQLite
(`node:sqlite`) does all the querying. Two dependencies, no native builds, no background services
required.

## Roadmap

Content search is the next stage: BM25 relevance over note bodies, scoped to a frontmatter filter,
so you can ask "the active within-tech notes, ranked by how well they discuss compensation" in one
query. The filter shrinks the haystack; the search finds the needle.

Beyond that, the corpus model isn't tied to markdown — anything carrying structured metadata
(document properties, sidecar JSON) can join it without changing the query surface.

## License

MIT © Kevin Malakoff
