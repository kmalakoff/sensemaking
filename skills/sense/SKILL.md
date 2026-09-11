---
name: sense
description: "Query a markdown tree with the sense CLI: filter notes by frontmatter, search prose, follow wikilinks and backlinks, trace link paths, find similar but unlinked notes, and inspect note outlines. Use when a task needs to query, filter, count, search, or report on a markdown directory; when a directory has sense.config.json; or when adding a saved sense query."
---

# sense

Use sense to locate evidence in a markdown tree before reading files. Every command reconciles changed files first. Results contain paths, metadata, excerpts, and line ranges. Read the returned files or ranges when the task needs their prose.

Setup, store selection, presets, and note design belong to the `sense-setup` skill. Translating an Obsidian Bases file belongs to `sense-bases`.

## Start with the tree

Run these when the tree or its configuration is unfamiliar:

```sh
sense status     # config, store, cache, document count, preset coverage
sense map        # fields, hubs, recent notes
sense --list     # saved queries
```

If a command reports a missing config, run `sense init` only when the user wants the tree configured. A one-off query does not authorize changing the tree.

## Choose the command

| Need | Command |
|---|---|
| Exact count, filter, grouping, or known-field report | `sense sql` or a saved SQL query |
| Notes about a subject | `sense search` |
| One note's frontmatter, outline, links, and backlinks | `sense peek` |
| Shortest link chain between two notes | `sense path` |
| Similar notes that a note does not link to | `sense related` |
| Tree shape and available fields | `sense map` |

Start with a bounded result. Raise `--k`, widen the preset, or broaden the words only when the first result does not answer the question.

```sh
sense search "pricing" --k 10
sense search "sourcing quotes" --preset raw
sense peek notes/pricing-model.md
sense path onboarding.md pricing-model.md
sense related notes/pricing-model.md --k 10
sense sql "SELECT path FROM frontmatter WHERE status = ? LIMIT 50" active
```

## Read the store guide before composing syntax

The config's `store` key selects the SQL dialect and text-search grammar. An omitted key means `sqlite`. Bare words and quoted phrases work in `sense search` on every store. Advanced operators and raw text-index SQL differ.

Read the matching guide before writing raw SQL that uses engine functions, dates, JSON, text matching, or native types. Also read it before using advanced search operators.

- [SQLite query guide](references/stores/sqlite.md)
- [DuckDB query guide](references/stores/duckdb.md)
- [Turso query guide](references/stores/turso.md)

The tables, `?` placeholders, quoted identifiers, `has()`, `basename()`, and preset `scope` binding are shared. [Portable SQL](references/sql.md) documents the schema and queries that work without depending on one engine.

## Search and evidence

`search` combines the signals enabled by the selected preset:

| Signal | Evidence |
|---|---|
| `match` | The note contains the search words. `snippets` shows the matching passages. |
| `link` | A note that matched links to this note. |
| `vector` | The embedding model placed this note near the query. The search words may be absent. |

Combinations such as `match+link` mean that more than one signal produced the row. `score` ranks rows within that result only. Do not compare it across searches. `similarity` ranks vector evidence within the current result and model. Do not carry a fixed similarity cutoff between trees.

The `lines` value points at the section that earned the row. Read that range when it is present. A null range means the whole note is the reference. A vector-only row has no lexical snippet and is a lead, not proof that the note contains the query terms.

Read [search evidence and troubleshooting](references/search.md) when a search will support a factual claim, when absence matters, when results look noisy, or when tuning signal weights.

## Scope and output

Bare commands use the `default` preset. `--preset <name>` chooses another. For `search`, `--include`, `--exclude`, and `--no-exclude` change the query scope for one invocation, but cannot reach files that no preset indexes. `sense status` shows actual coverage.

`--where` filters search and graph commands against frontmatter alias `f`:

```sh
sense search "pricing" --where "f.status = 'active' AND has(f.tags, 'sales')"
```

`sense sql` is index-wide by default. With `--preset`, the command binds a temporary `scope(path)` table. The SQL must join it:

```sh
sense sql "SELECT f.path FROM frontmatter f JOIN scope ON scope.path = f.path" --preset default
```

Table output is for people. Use `--format json` when code or an agent will parse rows. Use `--format csv` when redirecting a large row set to a file. `sql`, `search`, `related`, and saved queries support all three formats. `map`, `peek`, `status`, and `path` support table and JSON.

## Saved queries

Save a query in `sense.config.json` only when it will be reused:

```json
{
  "queries": {
    "by-tag": { "sql": "SELECT path, title FROM frontmatter WHERE has(tags, ?) ORDER BY path" },
    "hot": { "search": "pricing", "preset": "raw", "k": 20 }
  }
}
```

Run these as `sense by-tag urgent` and `sense hot`. Invocation flags override a saved search's `preset`, `k`, or `where` value.

Running a saved entry validates it. Exit code 0 means it ran, 2 means the invocation needs different arguments, and 1 means the query or store failed. An empty result can be valid data, so interpret it from the query's purpose.

## Tables

| Table | Holds |
|---|---|
| `frontmatter` | One discovered column per frontmatter key, plus `path`, `_mtime`, `_ctime`, `_size`, `_rank`, and `_parse_error` |
| `content` | `path`, `title`, `summary`, and authored text, plus store-owned search columns |
| `links` | `src`, written `target`, resolved `dst`, and `embed` |
| `tags` | Merged and deduplicated frontmatter and inline tags |
| `sections` | Heading, level, line range, and token estimate |
| `preset_files` | Paths covered by each preset |

Features can add tables. `sense map` and `sense status` show which features are active.

A non-null `_parse_error` means the file has no recovered frontmatter values. To distinguish a missing field from invalid frontmatter, include `_parse_error IS NULL` in the filter. Fixes appear on the next command because reconciliation runs first.

## Reading discipline

Select only the columns needed for the answer. Use `LIMIT` for row-returning exploration. Prefer `path`, `title`, `summary`, and bounded snippets over `content.text`. Aggregates such as `COUNT` and `GROUP BY` are already bounded by their result shape.

When a result identifies a large note, use `peek` and then read the relevant line range. Small files are often cheaper to read whole.

Worked command traces are in [EXAMPLES.md](EXAMPLES.md).

## Upkeep

- Install a missing CLI with `npm install -g sensemaking`.
- `sense status` prints the cache path and watcher state.
- Delete the cache directory printed by `sense status` only when the derived index is in doubt. The next command rebuilds it.
- Use `sense watch` when another process should keep the index warm during frequent edits. Queries remain responsible for their own freshness check.
