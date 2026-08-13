---
name: sense
description: Query a markdown tree with the sense CLI — filter notes by frontmatter, full-text search the prose, follow wikilinks/backlinks, and read note outlines. Use when the user wants to query, filter, count, search, or report on a folder of markdown notes, when you need to find which notes discuss a topic before reading them, when you want a note's backlinks or structure, when a directory has a sense.config.json, or when asked to add a named query to one.
---

# sense

SQL over a markdown tree, kept fresh by a filesystem check on every query. Four tables per file:
`frontmatter` (one column per key, plus `path`/`_mtime`/`_size`/`_rank`), `content` (FTS5:
`title`, `summary`, `text`), `links` (`src`, `target`, `dst` — `NULL` dst = dead link),
`sections` (heading outline with line ranges and token estimates).

## The descent

Spend tokens in this order (progressive disclosure: metadata first, payloads just in time); go
only as deep as the question needs.

1. `sense map` — orient once: fields, hub notes, recent changes. Fixed-size output.
2. `sense find "<terms>"` — locate: ranked references with excerpts, ~30 tokens/row.
   FTS5 standard: bare words AND-join (one absent word = zero rows) — write
   `a OR b OR c` for any-word matching.
3. `sense peek <path>` — structure before reading: outline with `[L143-162, ~380t]` ranges,
   links both ways. ~17% the cost of reading the file.
4. `Read` the line range peek gave you — not the whole file.

Every result is a reference, never file contents. Prefer `--format json` when consuming output.

## Verbs

```
sense find "pricing OR billing OR invoicing" --where "f.status = 'active'" --k 10
sense peek notes/pricing-model.md               # a unique basename also works
sense map
sense query "<sql>" [params...]                 # ad-hoc SQL; ? binds positional args, count-checked
sense <name> [params...]                        # named query from sense.config.json
sense --list | status | rebuild
```

- **Expand terms before searching.** Write `pricing OR billing OR invoicing`, not one word — you
  know the synonyms; the index only knows the words in the files. Expand categories into their
  likely members too: a note about TypeScript never says "programming language".
- Terms pass verbatim to FTS5 MATCH. Bare words AND-join — one absent word means zero rows —
  so write `OR` yourself when you want any-word matching; invalid syntax is an error, not a
  rewrite.
- **Over-fetch, then choose.** `--k 20`, read the rows, open the 2–3 that matter.
- `find` fuses BM25 with link-graph expansion; the `via` column says what produced each row —
  `match` (terms hit), `link` (connected to notes that hit), `match+link` (both).
- `--where` takes a frontmatter condition against alias `f`, e.g. `"f.status = 'active' AND has(f.tags, 'x')"`.

## SQL, when the verbs aren't enough

```
sense query "SELECT name FROM pragma_table_info('frontmatter')"          # what fields exist
sense query "SELECT DISTINCT status FROM frontmatter"                    # what values a field takes
sense query "SELECT src FROM links WHERE dst = ?" notes/pricing-model.md  # backlinks
sense query "SELECT src, target FROM links WHERE dst IS NULL"            # dead links
sense query "SELECT path FROM frontmatter WHERE path NOT IN (SELECT dst FROM links WHERE dst IS NOT NULL)"  # orphans
sense query "SELECT heading, start_line, tokens FROM sections WHERE path = ?" a.md   # budget a read
sense query "SELECT j.value, COUNT(*) n FROM frontmatter, json_each(frontmatter.tags) j GROUP BY j.value ORDER BY n DESC"   # count per array member
```

- `content MATCH` takes FTS5 syntax: `a OR b`, `"phrase"`, `pref*`, `NEAR(a b, 5)`,
  `summary: term`. Stemmed; markdown stripped at index time.
- Rank with `ORDER BY bm25(content, 10.0, 5.0, 1.0)` (title > summary > body); excerpt with
  `snippet(content, -1, '«', '»', '…', 10)`.
- Select `content.title`/`content.summary` (always exist, empty when absent) rather than
  `f.title`/`f.summary` (discovered columns — error on vaults that never declare them).
- `has(field, value)`: array membership on JSON-array fields, substring on strings, false on NULL.
  To aggregate per member instead, use `json_each(frontmatter.<field>)` (above) -- GROUP BY on the
  raw column splits `["a","b"]` and `["b","a"]` into separate buckets.
- Date fields are stored as written. Compare through `datetime()`, which normalizes ISO 8601
  timezone offsets to UTC: `WHERE datetime(dateCreated) >= datetime(?)`. Bare string comparison
  is only safe when every note uses the same offset.
- Never `SELECT text FROM content` — that is the whole vault into context. `SELECT * FROM
  frontmatter` is safe; prose is not a frontmatter column. Always `LIMIT`.

Worked traces: [EXAMPLES.md](EXAMPLES.md).

## Setup and upkeep

- Missing CLI: `npm install -g sensemaking`. Missing config: `sense init` at the tree root.
  Discovery walks up from cwd; `--config <path>` overrides.
- Save a query into `sense.config.json` only when it will be reused; run ad-hoc otherwise.
- When writing notes, give each a one-line `summary:` — it appears in every result row and is a
  weighted search field. Write date fields as ISO 8601 (`2026-08-12`, or with time and offset) —
  the only format SQL date comparisons understand.
- Reserved frontmatter keys (dropped with a warning): `path`, `_mtime`, `_size`, `_rank`,
  `content`, `links`, `sections`.
- Exit codes: `0` ok, `1` error (SQLite message verbatim), `2` usage (unknown query, wrong
  param count).
- Doubted cache: `sense rebuild`. Rarely needed — every query reconciles first.
