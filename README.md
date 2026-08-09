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

Every file becomes a row; every frontmatter key becomes a column; the prose becomes a full-text
index you can join against. You write named SQL queries once and run them by name.

```markdown
---
title: Ship the Q3 report
summary: where the Q3 numbers came from and who signed off
status: active
tags: [urgent, reports]
---

Notes about the report…
```

```sql
-- active notes that actually discuss revenue, best match first
SELECT f.path, content.title, content.summary, snippet(content, -1, '«', '»', '…', 10) AS hit
FROM frontmatter f JOIN content ON content.path = f.path
WHERE f.status = 'active' AND content MATCH 'revenue'
ORDER BY bm25(content, 10.0, 5.0, 1.0) LIMIT 10
```

The filter shrinks the haystack, the search finds the needle, and each row that comes back —
path, title, summary, matching excerpt — is enough to decide whether to open the file, without
carrying the file. On a real 26-note vault that's a few hundred tokens, against ~6,000 to read the
three files it points at. Cheap enough to run before deciding what to open; reading afterward is
the expensive step, and it happens through the filesystem, not SQL.

Two properties make it trustworthy:

- **Never stale.** Every query re-checks the filesystem first, re-reading only what changed. The
  SQLite cache under `.sense/` is disposable — delete it any time, the next query rebuilds it. An
  agent can trust a result without knowing when anything was last indexed.
- **Headless.** Files on disk are the only source of truth. Nothing needs to be open — not
  Obsidian, not a server, not a daemon.

## Use it

```bash
npm install -g sensemaking
cd your-notes && sense init        # writes a minimal sense.config.json (globs only, no queries)
```

Query immediately — ad-hoc SQL needs no config beyond the globs:

```
sense query "SELECT … FROM frontmatter"    # ad-hoc SQL; positional args bind to ? placeholders
sense query "…" --format json      # structured output (the default is a table)
sense --list                       # what named queries exist
sense status | rebuild             # cache info / delete .sense/ and re-crawl
```

When a query proves worth reusing, name it in `sense.config.json` (plain JSON; the `$schema` line
gives your editor autocomplete and validation) and run it as `sense <name> [params...]`:

```json
{
  "$schema": "https://unpkg.com/sensemaking/schema.json",
  "version": 1,
  "scan": { "include": ["**/*.md"] },
  "queries": {
    "by-tag": "SELECT path, title, summary FROM frontmatter WHERE has(tags, ?) ORDER BY path"
  }
}
```

Discovery walks up from your cwd git-style, so you can run `sense` from anywhere in the tree
(`--config <path>` overrides). Exit codes: `0` ok, `1` real error (SQLite's message verbatim),
`2` usage error.

The one custom SQL function is `has(field, value)`: array membership on a JSON-array field (like
`tags`), substring match on a string, always false on a missing key. Reserved names: `path`,
`_mtime`, `_size`, `content`.

### Content search

`content` is an FTS5 table with columns `title`, `summary`, `text`, and `path` (for the join).
`content MATCH ?` takes FTS5 syntax (`a OR b`, `"exact phrase"`, `pref*`, `NEAR(a b, 5)`,
`summary: term`), with stemming on so `negotiate` matches "negotiating". Markdown syntax is
stripped at index time — search for the words, not the formatting around them, and excerpts come
back as clean prose. `bm25()` weights follow column order, so `bm25(content, 10.0, 5.0, 1.0)`
ranks a title hit above a passing mention; `snippet(content, -1, …)` excerpts whichever column
matched.

Prose is deliberately **not** a column on `frontmatter`, so `SELECT * FROM frontmatter` can never
dump your notes into an agent's context — reaching it takes an explicit join. Select `path`,
`title`, `summary`, and a `snippet()`, keep a `LIMIT`, and read the files worth reading. `sense`
warns on stderr when a result grows past 50 KB.

A one-line `summary:` in frontmatter is worth adding as you write — what's on the page and when
it's worth opening, like a skill's `description:`. It's both a column you can select (a search
result row often answers the question with no file read at all) and a weighted search field.

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

- **Obsidian (Bases/Dataview):** filters this well, but only inside the running Electron app —
  scripts and agents can't query it headless. Your vault works unmodified either way; Obsidian
  stays a fine viewer for the same files.
- **RAG / semantic search:** ranks by similarity, not hard constraints like "only active notes from
  this project" — that needs a `WHERE` clause. The two compose: filter first, rank later; vector
  similarity, if added later, would join the same way.
- **An LLM-written index file** (à la Karpathy's llm-wiki `index.md`): a good instinct, but a
  second artifact that drifts out of sync. `frontmatter` is that catalog, derived from the notes
  themselves on every query.
- **Index-on-build tools (MarkdownDB and similar):** query a snapshot that's stale the moment a
  file changes, instead of reconciling live.
- **Note CLIs (zk and similar):** good at their own model — tags, links, full text — but can't
  filter on arbitrary frontmatter fields, which is the whole point here.
- **grep / one-off scripts:** fine until you want named, reusable, parameterized queries with real
  AND/OR/ORDER BY — at which point you've started writing a worse query engine.

`sensemaking` is deliberately thin glue: [gray-matter](https://github.com/jonschlinkert/gray-matter)
parses, [remove-markdown](https://github.com/zuchka/remove-markdown) cleans the prose for indexing,
[fast-glob](https://github.com/mrmlnc/fast-glob) walks, and Node's built-in SQLite (`node:sqlite`)
does all the querying. Three small dependencies, no native builds, no background services required.

## Roadmap

Vector similarity is the natural next facet — a `doc_vec` table joined the same way `content` is,
so semantic recall composes with the frontmatter filter instead of living in a separate tool
(`SELECT path, distance`, never the embedding). It's deferred, not planned: today it would require
a native SQLite extension (sqlite-vec is pre-v1 and ships platform binaries), which breaks the
no-native-builds line above. It becomes worth revisiting when Node can do it dependency-free — and
only if BM25 demonstrably misses things; on a curated vault of a few hundred notes it often
doesn't.

Beyond that, the corpus model isn't tied to markdown — anything carrying structured metadata
(document properties, sidecar JSON) can join it without changing the query surface.

## License

MIT © Kevin Malakoff
