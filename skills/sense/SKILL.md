---
name: sense
description: Query a markdown tree with SQL via the sense CLI — filter notes by YAML frontmatter, then full-text search inside them. Use when the user wants to query, filter, count, search, or report on a folder of markdown notes, when you need to find which notes discuss a topic before reading them, when a directory has a sense.config.json, when asked what named queries exist, or when asked to add a new query to one.
---

# sense

`sense` runs SQL over a tree of markdown files. Two tables, two facets of the same document:

| table         | one row per file holds…                                               | for…              |
|---------------|------------------------------------------------------------------------|-------------------|
| `frontmatter` | one column per frontmatter key (+ reserved `path`, `_mtime`, `_size`)  | filtering         |
| `content`     | FTS5 index: `title`, `summary`, `text` (+ `path` to join on)           | searching/ranking |

No running app required — every query re-checks the filesystem first, so results are never stale.

## The flow: query → decide → Read

A query result is *references with evidence*, never file contents: `path`, `title`, `summary` (if
present), `hit` (matching excerpt) — enough to decide whether a file is worth opening at ~2% of
the token cost of reading it. Then `Read` the one or two paths that matter.

```
sense query "SELECT f.path, content.title, content.summary, snippet(content, -1, '«', '»', '…', 10) AS hit
  FROM frontmatter f JOIN content ON content.path = f.path
  WHERE content MATCH ?
  ORDER BY bm25(content, 10.0, 5.0, 1.0) LIMIT 10" "compensation OR equity" --format json
```

Select `title`/`summary` from `content`, where they always exist (empty when a note lacks the
key) — on `frontmatter` they're discovered columns, present only if some note declares them, so
`f.summary` errors on a vault with no summaries yet. Add frontmatter conditions
(`f.status = 'active' AND has(f.track, ?)`) to the same WHERE — the filter and the search compose
in one query. Worked traces for the common cases (discovery,
known-field filtering, cold start, anti-patterns): [EXAMPLES.md](EXAMPLES.md).

## Before anything else

Confirm `sense` is installed (`sense --list` or `which sense`; if missing,
`npm install -g sensemaking`) and that a config exists. Discovery walks **up** from cwd looking for
`sense.config.json`, same as git looks for `.git` — you don't need to `cd` to the project root, and
`--config <path>` bypasses discovery entirely. If no config exists yet, `sense init` at the tree's
root writes a minimal one (globs only, no queries — ad-hoc `sense query` works immediately).

## Cold start: discover what's queryable

```
sense --list                                                              # named queries, if any
sense query "SELECT name FROM pragma_table_info('frontmatter') ORDER BY name"  # what frontmatter fields exist
sense query "SELECT DISTINCT status FROM frontmatter"                      # what values a field takes
```

If you wrote the notes, you already know the fields; the pragma is for vaults you didn't build.

## Run a query

```
sense <name> [params...] --format json     # named query from sense.config.json
sense query "<sql>" [params...]            # ad-hoc SQL, no config edit
```

**Prefer `--format json` when consuming output as an agent.** Positional args bind to `?`
placeholders in order, count-checked strictly (wrong count = exit 2, never a silent empty result).
Save a query into `sense.config.json` (plain JSON, edit directly) only when it's meant to be
reused as a named view — never add-then-remove one for a one-off question.

## Search syntax and ranking

- `content MATCH ?` takes FTS5 syntax: `a OR b`, `a AND b`, `"exact phrase"`, `pref*`,
  `NEAR(a b, 5)`, column-scoped `summary: onboarding`.
- `bm25(content, 10.0, 5.0, 1.0)` — weights follow column order (title, summary, text), so a
  title hit outranks a passing mention. Lower is better; plain `ORDER BY bm25(…)` sorts best-first.
- `snippet(content, -1, '«', '»', '…', 10)` — bounded excerpt; `-1` picks whichever column
  matched; the last argument is the excerpt budget in tokens.
- Stemming is on (`negotiate` matches "negotiating"); markdown syntax is stripped at index time,
  so snippets are clean prose and `**bold**` matches `bold`.

## Keep results small

- Select `path, title, summary` + a `snippet()` — never `SELECT text FROM content`, which dumps
  the whole tree into context (`sense` warns on stderr past 50 KB).
- Always `LIMIT`. Ten rows is plenty; widen only if they all look wrong.
- `SELECT * FROM frontmatter` is safe — prose is deliberately not a `frontmatter` column.

## When writing notes, not just querying them

Give every note a one-line `summary:` in its frontmatter — what's on the page and when it's worth
opening, like a skill's `description:`. It pays twice: it appears in result rows (often answering
the question with no file read at all), and it's a weighted search field. Keep it to one line.

Reserved frontmatter key names (dropped with a warning): `path`, `_mtime`, `_size`, `content`.

## `has()` semantics

The one custom SQL function, for frontmatter fields that are arrays or free text:

| field type               | `has(field, value)` means |
|--------------------------|---------------------------|
| JSON array (e.g. `tags`) | array membership          |
| string                   | substring match           |
| NULL (key absent)        | always false              |

## Exit codes

`0` success · `1` a real error (bad config, SQL error — the SQLite message is printed verbatim) ·
`2` usage error (missing query name, unknown query name, wrong parameter count).

## When results look stale

`sense rebuild` deletes the local `.sense/` cache and re-crawls from scratch. Rarely needed since
every query reconciles on open — use it if you doubt the cache. `sense status` shows doc count, db
path, and whether a background `sense watch` (optional pre-warmer) is running.
