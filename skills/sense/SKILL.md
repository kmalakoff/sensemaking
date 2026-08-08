---
name: sense
description: Query a markdown tree's YAML frontmatter with SQL via the sense CLI. Use when the user wants to query, filter, count, or report on a folder of markdown notes by their frontmatter fields, when a directory has a sense.config.json, when asked what named queries exist, or when asked to add a new query to one.
---

# sense

`sense` runs SQL over the frontmatter of a tree of markdown files. Each file is a row in a
`docs` table (one column per frontmatter key); the file's own content is never queried, only its
frontmatter. A running app is **never** required — files on disk are the only source of truth.

## Before anything else

Confirm `sense` is installed (`sense --list` or `which sense`; if missing, `npm install -g sense`)
and that a config exists. Discovery walks **up** from cwd looking for `sense.config.json`, same as
git looks for `.git` — you don't need to `cd` to the project root, and `--config <path>` bypasses
discovery entirely. If no config exists yet in the tree you're being asked to query, run
`sense init` at its root to write a starter config, then tailor the queries.

## See what's queryable

```
sense --list
```

Prints the named queries defined in `sense.config.json`, sorted. Read that file directly if you
need to see the SQL, not just the names.

## Run a query

```
sense <name> [params...] --format json
```

**Prefer `--format json` when consuming output as an agent** — it's structured and avoids parsing
a padded text table. `--format table` (the default) is for humans at a terminal.

Named queries may contain `?` placeholders; positional arguments after the name bind to them in
order. The parameter count is checked strictly — passing the wrong number of arguments is a usage
error (exit 2), never a silent empty result.

```
sense by-tag urgent --format json
```

## One-off questions: `query`, not config edits

For an ad-hoc question, run SQL directly — do NOT add a temporary query to
`sense.config.json` and remove it afterward:

```
sense query "SELECT path FROM docs WHERE has(phase, 'screen') AND NOT has(phase, 'explore')" --format json
sense query "SELECT path FROM docs WHERE has(tags, ?)" urgent --format json
```

Save a query into `sense.config.json` only when it's meant to be reused as a named view.

## `has()` semantics

The one custom SQL function, for frontmatter fields that are arrays or free text:

| field type              | `has(field, value)` means      |
|--------------------------|---------------------------------|
| JSON array (e.g. `tags`) | array membership                |
| string                   | substring match                 |
| NULL (key absent)        | always false                    |

## Adding a named query

Edit `sense.config.json` directly — it's plain JSON, not something sense itself writes:

```json
{
  "scan": { "include": ["**/*.md"] },
  "queries": {
    "my-query": "SELECT path, title FROM docs WHERE has(tags, ?) ORDER BY path"
  }
}
```
`scan.include` globs and query results are both relative to the config file's own directory,
regardless of your cwd. Reserved columns (don't use as frontmatter key names): `path`, `_mtime`,
`_size`.

## Exit codes

`0` success · `1` a real error (bad config, SQL error — the SQLite message is printed verbatim) ·
`2` usage error (missing query name, unknown query name, wrong parameter count).

## When results look stale

`sense rebuild` deletes the local `.sense/` cache and re-crawls every file from scratch. Every
query already reconciles the cache against the filesystem on open, so this is rarely needed — use
it if you doubt the cache rather than trying to debug it. `sense status` shows the doc count, db
path, and whether a background `sense watch` process is running (it's an optional pre-warmer, not
a correctness requirement).
