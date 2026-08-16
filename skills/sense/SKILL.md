---
name: sense
description: Query a markdown tree with the sense CLI — filter notes by frontmatter, full-text search the prose, follow wikilinks/backlinks, and read note outlines. Use when the user wants to query, filter, count, search, or report on a folder of markdown notes, when you need to find which notes discuss a topic before reading them, when you want a note's backlinks or structure, when a directory has a sense.config.json, or when asked to add a named query to one.
---

# sense

SQL over a markdown tree, kept fresh by a filesystem check on every query. Every file becomes
rows in `frontmatter` (one column per key, plus `path`/`_mtime`/`_size`/`_rank`), `content`
(FTS5: `title`, `summary`, `text`), `links` (`src`, `target`, `dst` — `NULL` dst = dead link),
and `sections` (heading outline with line ranges and token estimates). Features add their own
storage; `map` and `status` report which are on.

## What each tool is for

Every result is a reference (path, metadata, excerpt), never file contents; prose enters
context only when you Read it. Costs: `map` is fixed-size, a `search` row is tens of tokens,
and a `peek` stays flat however large the note is. Which tool fits is a property of the
question:

- A deterministic, factual answer over known fields — counts, filters, "which notes have
  X" — is SQL: `sense query`, a named query, or `search --where`. Enumerates every match;
  same result regardless of phrasing.
- Locating notes about something is `search` — one text through every engine the scope
  has: word match (bare words AND-join — one absent word = zero lexical rows; write
  `a OR b OR c` for any-word), link-graph expansion, and vector similarity, fused into one
  ranked list. Read `via` per row: `match` rows contained your words; `vector`-only rows
  did not — they are the "these words aren't in the tree; this is what's near in meaning"
  signal. Vector rows are conceptual similarity, not typo-tolerance; false positives are
  expected, labeled, and bounded by `--k`. `--lexical` skips vectors for one command when
  word-presence is the question.
- `map` answers "what is this tree" — fields, hub notes, recent changes — when the tree is
  unfamiliar.
- `peek <path>` prices a file before you pay for it: outline with `[L143-162, ~380t]`
  ranges, links both ways. Every list shows its first 20 with the true total; the
  `sections` and `links` tables hold the rest, so a peek costs a few hundred tokens on any
  note — heading-dense monsters included.
- When you know the file and need its contents, `Read` it — sense adds nothing there. On
  large files peek's ranges let you read just one section; small files are often cheaper
  whole.

Output defaults to a table, built for humans; `--format json` returns the same rows
machine-parseable.

## Commands

```
sense search "pricing OR billing OR invoicing" --where "f.status = 'active'" --k 10
sense search "sourcing quotes" --preset raw     # a named settings bundle from the config
sense peek notes/pricing-model.md               # a unique basename also works
sense map
sense query "<sql>" [params...]                 # ad-hoc SQL; ? binds positional args, count-checked
sense <name> [params...]                        # named query or saved search from sense.config.json
sense --list | status | rebuild | check
```

- Terms pass verbatim to FTS5 MATCH. Bare words AND-join — one absent word means zero rows —
  so write `OR` yourself when you want any-word matching; double-quote punctuated terms
  (`"customer-facing"`, `"founder's"`); invalid syntax is an error, not a rewrite. The same
  rules apply to search commands you write into subagent briefs.
- When a search misses, the recall levers are: OR-in synonyms and concrete instances (the
  index only knows the words in the files — a note about a specific tool rarely names its
  category), raise `--k` (a row costs tens of tokens), and widen the scope (`--preset`, or
  `--include` for an ad-hoc glob). Vector rows already cover the meaning-over-words gap by
  default. Each widening adds candidates and dilutes ranking, so the noise trade-off runs
  both ways.
- A frontmatter query enumerates its matches deterministically; search ranks by term overlap,
  so results shift as phrasing shifts. Trade-off: a query needs a known field, search doesn't.
- The `via` column says what produced each row — `match` (words hit), `link` (connected to
  notes that hit), `vector` (near in meaning), and combinations. The `lines` column, when
  set, points at the section that earned the row — the best-matching chunk on vector rows,
  the term cluster's section on large lexical notes — and is a direct `Read` range; null
  means the whole note is the reference.
- Scope comes from presets: bare `search` uses the config's `default` preset; `--preset
  <name>` picks another (unknown names error, listing what's declared); `--include <glob>`
  is an ad-hoc scope that replaces the preset's globs for one command. `--where` takes any
  SQL condition against frontmatter alias `f` — not only field equality:
  `"f.status = 'active' AND has(f.tags, 'x')"`, `"datetime(f.created) >= datetime(?)"` —
  and filters within the scope. `sense status` shows every preset with its coverage.
- `score` is a rank-fusion value: it ranks rows within one result set and is not comparable
  across queries, not a relevance magnitude — it encodes how many signals fired and at what
  rank, so a perfect lexical hit and a weak vector-only hit can read the same number. With
  vectors active, rows carry `similarity`: the cosine (-1 to 1) of the query against that
  file's best-matching chunk — the same chunk the `lines` range points at. It orders vector
  evidence within a result set; the range it spans depends on the corpus and the embedding
  model, and compresses on small trees, where even a nonsense query has a moderately near
  neighbour somewhere. Compare similarities within a result set rather than against a fixed
  cutoff carried between trees.
- Absence evidence lives in the labels: `search --lexical` (or a semantic-off scope)
  returns 0 rows when the words are nowhere in the tree. Default `search` always returns
  up to `k` rows — nearest-neighbour search has a nearest neighbour for any input — so a
  result of only `via: vector` rows IS the absence signal for the words themselves;
  `similarity` and the snippet are the evidence for judging whether a vector row is a real
  conceptual hit.
- Besides SQL strings, a config entry can save a whole search:
  `"hot": { "search": "pricing OR billing", "preset": "raw", "k": 20 }` runs as
  `sense hot` — the scenario's settings ride along with the name, so repeat runs need no
  flags. An invocation-level `--preset`, `--k`, `--where`, or `--lexical` overrides the
  saved value; `--list` marks these entries `(search)`.
- `sense check` prepares every saved query and probes every saved search lexically with
  k=1, so a typo'd column, stale SQL, bad FTS5 syntax, or unknown preset fails at check
  time instead of silently mid-task. It reports row counts; whether an empty result is
  good or bad is the reader's judgment — a dead-link query returning rows means broken
  citations to fix, and the agent reads that directly.

## SQL

The commands are shorthands over those tables; anything they don't express, SQL does.

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
  `summary: term`. Stemmed; markdown stripped at index time. Double-quote any term with
  punctuation — bare `customer-facing` errors (`-` reads as a column filter), bare
  apostrophes are syntax errors: write `"customer-facing"`, `"founder's"`.
- Rank with `ORDER BY bm25(content, 10.0, 5.0, 1.0)` (title > summary > body); excerpt with
  `snippet(content, -1, '«', '»', '…', 10)`. snippet() re-tokenizes each matched doc and its
  cost grows superlinearly with doc size — measured ~10 s per query on a tree holding one
  1 MB note. `search` bounds this itself (docs past 16 KB get an equivalent excerpt another
  way); in hand-written SQL, guard it: `CASE WHEN length(text) <= 16384 THEN snippet(...)
  END`, or select `title`/`summary` instead of an excerpt.
- Select `content.title`/`content.summary` (always exist, empty when absent) rather than
  `f.title`/`f.summary` (discovered columns — error on trees that never declare them).
- Frontmatter values keep their YAML type: strings are TEXT, whole numbers and booleans are
  INTEGER (`true` stores as 1, so `WHERE flag = 1` matches and `WHERE flag = 'true'` matches
  nothing), fractions are REAL, lists and maps are JSON text. `map` prints the observed type
  per field, and a field showing two types (`integer,text`) has drifted across notes.
- `has(field, value)`: array membership on JSON-array fields, substring on strings, false on NULL
  — the `includes()` convention. Substring means `has(f.status, 'active')` also matches
  `inactive`; exact scalar match is `f.status = ?`, deliberate substring is `LIKE`, exact array
  membership is `EXISTS (SELECT 1 FROM json_each(f.tags) WHERE value = ?)`.
  To aggregate per member instead, use `json_each(frontmatter.<field>)` (above) -- GROUP BY on the
  raw column splits `["a","b"]` and `["b","a"]` into separate buckets.
- Date fields are stored as written. Compare through `datetime()`, which normalizes ISO 8601
  timezone offsets to UTC: `WHERE datetime(created) >= datetime(?)`. Bare string comparison
  is only safe when every note uses the same offset.
- To bound what a query puts into context: `snippet()` excerpts just the matching text,
  `LIMIT` caps row counts, and selecting `path`/`title`/`summary` keeps rows small.
  `SELECT text FROM content` returns the tree's entire prose (sense warns past 50 KB).
  Aggregates (`COUNT`, `GROUP BY`) are already bounded. `SELECT * FROM frontmatter` is always
  safe — prose is not a frontmatter column.

Worked traces: [EXAMPLES.md](EXAMPLES.md).

## Setup and upkeep

- Missing CLI: `npm install -g sensemaking`. Missing config: `sense init` at the tree root.
  Discovery walks up from cwd; `--config <path>` overrides. Setting up or restructuring a
  tree (presets, frontmatter conventions, note design) is the `sense-setup` skill.
- `map` and `status` report each preset's coverage (files matched, embedded count) —
  indexing derives from presets, so the coverage numbers are how you see what a config
  actually indexes and embeds. A scope with fewer signals just uses fewer (a semantic-off
  preset searches lexically); a saved search naming an unknown preset errors at `check`.
- Save a query into `sense.config.json` only when it will be reused; run ad-hoc otherwise.
- A one-line `summary:` per note is optional and pays twice: it appears in result rows and is a
  weighted search field. Date comparisons work for dates written as ISO 8601 (`2026-08-12`, or
  with time and offset) — the only format `datetime()` parses. Field names in examples
  (`status`, `tags`, `created`) are illustrative; your tree defines its own.
- Reserved frontmatter keys (dropped with a warning): `path`, `_mtime`, `_size`, `_rank`,
  `content`, `links`, `sections`.
- Exit codes: `0` ok, `1` error (SQLite message verbatim), `2` usage (unknown query, wrong
  param count).
- Doubted cache: `sense rebuild`. Rarely needed — every query reconciles first.
