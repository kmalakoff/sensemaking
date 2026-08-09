# sense: worked examples

Every query returns *references with evidence* — enough to decide which files to open, never the
files themselves. Reading happens afterward, through the filesystem, on the paths that earned it.

Token counts below are from a real 26-note vault (~62 KB of markdown): a search costs ~1–2% of
reading the files it points at.

## A. "Does the vault say anything about X?" (discovery search)

The question an agent should ask *before* reading anything — cheap enough to run speculatively.

```
sense query "SELECT f.path, content.title, content.summary, snippet(content, -1, '«', '»', '…', 10) AS hit
  FROM frontmatter f JOIN content ON content.path = f.path
  WHERE content MATCH ?
  ORDER BY bm25(content, 10.0, 5.0, 1.0) LIMIT 10" "compensation OR salary" --format json
```

```json
[
  {
    "path": "knowledge/compensation-floor.md",
    "title": "Compensation floor",
    "summary": "The comp floor and how to apply it when screening",
    "hit": "«Compensation» floor Kevin's «compensation» preference for the later job…"
  },
  {
    "path": "methodology/jobs-table-schema.md",
    "title": "Jobs table schema",
    "summary": "",
    "hit": "…B Company employer C «Salary» as posted; blank if not…"
  }
]
```

~55 tokens per row. Decide from `title`/`summary`/`hit`; often the row itself answers the
question. If not, `Read knowledge/compensation-floor.md` (~800 tokens) — one file, not the vault
(~16,000 tokens).

Note the `content.title`/`content.summary` spelling: those columns always exist on `content`
(empty string when a note lacks the key), so this query works on any vault. `f.title`/`f.summary`
only work once some note actually declares the key — `frontmatter` columns are discovered, not fixed.

## B. Filtering on frontmatter you already know (no content search)

When the fields are known — typically because an agent wrote the notes to a schema — plain SQL on
`frontmatter` is the whole query. No join needed when you aren't searching prose:

```
sense query "SELECT path, title, summary FROM frontmatter
  WHERE status = 'active' AND has(track, ?) ORDER BY updated DESC" within-tech --format json
```

`has()` does array membership on JSON-array fields (`track: [a, b]`), substring on strings, false
on missing keys. A note missing `summary` yields NULL — costs nothing, breaks nothing. (Only if
*no* note in the vault declares a key does its column not exist at all — pattern D's pragma shows
what's there.)

## C. Filter + search + rank in one query

The case neither grep nor a frontmatter-only tool can do: a hard constraint AND a relevance
ranking, composed.

```
sense query "SELECT f.path, content.title, content.summary, snippet(content, -1, '«', '»', '…', 10) AS hit
  FROM frontmatter f JOIN content ON content.path = f.path
  WHERE f.status = 'active' AND has(f.track, 'within-tech') AND content MATCH ?
  ORDER BY bm25(content, 10.0, 5.0, 1.0) LIMIT 10" remote --format json
```

The frontmatter conditions are hard filters (a non-active note can never appear); the `MATCH` +
`bm25()` ranks whatever survives. The join exists **only** for `MATCH`/`bm25()`/`snippet()` —
never use it to fetch text.

## D. Cold start: a vault you didn't build

```
sense --list                                                                # named queries, if any
sense query "SELECT name FROM pragma_table_info('frontmatter') ORDER BY name"  # discover the fields
sense query "SELECT DISTINCT type FROM frontmatter"                         # discover a field's values
sense query "SELECT count(*) AS n FROM frontmatter"                         # corpus size
```

Each costs a few dozen tokens and turns an unknown corpus into a queryable schema. From there,
patterns A–C apply.

## E. Search syntax worth knowing

```
"exact phrase"          # phrase match
compensat*              # prefix
summary: onboarding     # only match in the summary field
title: retro OR text: retrospective
NEAR(salary negotiate, 8)
```

Stemming is on: `negotiate` finds "negotiating". Markdown is stripped from the index, so search
for the words, not the syntax around them.

## F. Anti-patterns

```
sense query "SELECT text FROM content"          # dumps every note into context
```
This is the one query shape that defeats the tool's purpose. `sense` warns on stderr when a
result exceeds 50 KB (stdout stays clean for --format json), but the fix is upstream: select
`path` + `snippet()`, keep a `LIMIT`, and `Read` the files that deserve it.

Other traps:
- **No `LIMIT`** on a search — fine on a tiny vault, a context bomb on a big one. Habit: always.
- **Fetching content through SQL** because the join is there. The join ranks; the filesystem
  retrieves. An agent already has `Read` and `grep` for the path the query returned.
- **Adding a named query for a one-off question.** `sense query "<sql>"` exists so the config
  only accumulates queries that are genuinely reused.
