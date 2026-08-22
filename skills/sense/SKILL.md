---
name: sense
description: "Query a markdown tree with the sense CLI: filter notes by frontmatter, full-text search the prose, follow wikilinks/backlinks, trace how notes connect (link path, similar-but-unlinked), and read note outlines. Use when the user wants to query, filter, count, search, or report on a folder of markdown notes, when you need to find which notes discuss a topic before reading them, when you want a note's backlinks or structure, when you want to know how two notes connect, when a directory has a sense.config.json, or when asked to add a saved entry to one."
---

# sense

SQL over a markdown tree, kept fresh by a filesystem check on every query. Every file becomes rows in `frontmatter` (one column per key, plus `path`/`_mtime`/`_size`/`_rank`/`_parse_error`), `content` (FTS5: `title`, `summary`, `text`), `links` (`src`, `target`, `dst`; `NULL` dst = dead link), `sections` (heading outline with line ranges and token estimates), and `preset_files` (`path`, `preset`: which presets cover which files). Features add their own storage; `map` and `status` report which are on.

## What each tool is for

Every result is a reference (path, metadata, excerpt), never file contents; prose enters context only when you Read it. Costs: `map` is fixed-size, a `search` row is tens of tokens, and a `peek` stays flat however large the note is. Which tool fits is a property of the question:

- A deterministic, factual answer over known fields (counts, filters, "which notes have X") is SQL: `sense sql`, a saved `{ sql }` entry, or `search --where`. Enumerates every match; same result regardless of phrasing.
- Locating notes about something is `search`, one text through every engine the scope has: word match (bare words AND-join, one absent word = zero lexical rows; write `a OR b OR c` for any-word), link-graph expansion, and vector similarity, fused into one ranked list. Read `via` per row: `match` rows contained your words; `vector`-only rows did not. A `vector`-only row means the search words don't appear in that note; it showed up because the model judged it semantically related. Vector rows are conceptual similarity, not typo-tolerance; false positives are expected, labeled, and bounded by `--k`. A scope searches with vectors when its preset has `semantic` on (the default) and the tree names an `embed` model; a `semantic: false` preset searches on words and links. A preset that asks for vectors when the model is not downloaded is an error naming `sense download`, not a quieter result: the same search must not answer differently before and after a download.
- `map` answers "what is this tree" (fields, hub notes, recent changes) when the tree is unfamiliar.
- `peek <path>` prices a file before you pay for it: outline with `[L143-162, ~380t]` ranges and links both ways. Every list shows its first 20 with the true total; the `sections` and `links` tables hold the rest, so a peek costs a few hundred tokens on any note.
- `path <a> <b>` walks the link graph for a chain connecting two notes, or reports none within the depth bound: it answers how they connect, not just that both exist.
- `related <note>` ranks notes near in meaning to one note that it does not already link to: the links it is missing. It reads the meaning-vectors, so it needs vectors on for the scope and scans them, costing about what a semantic `search` does, not what a `peek` does. Vectors need the model on disk; nothing fetches it implicitly, so `sense download` is a one-time step per machine. Without it `search` still answers on words and links (it prints a note saying vectors are off), while `related` reports the missing model instead of an empty list.
- When you know the file and need its contents, `Read` it. sense adds nothing there. On large files peek's ranges let you read just one section; small files are often cheaper whole.

Output defaults to a table, built for humans; `--format json` returns the same rows machine-parseable. That also makes a saved query usable as a CI/hook gate with zero added mechanism: `[ "$(sense <name> --format json)" = "[]" ]` is true exactly when it returned no rows.

## Commands

```
sense search "pricing OR billing OR invoicing" --where "f.status = 'active'" --k 10
sense search "sourcing quotes" --preset raw     # a named settings bundle from the config
sense peek notes/pricing-model.md               # a unique basename also works
sense path onboarding.md pricing-model.md       # link chain between two notes, or none within the bound
sense related notes/pricing-model.md            # notes similar by meaning it does not yet link to
sense map
sense sql "<statement>" [params...]             # ad-hoc SQL; ? binds positional args, count-checked
sense <name> [params...]                        # a saved query from sense.config.json
sense --list | status | download
```

- Terms pass verbatim to FTS5 MATCH. Bare words AND-join (one absent word means zero rows), so write `OR` yourself when you want any-word matching; double-quote punctuated terms (`"customer-facing"`, `"founder's"`); invalid syntax is an error, not a rewrite. The same rules apply to search commands you write into subagent briefs.
- When a search misses, the recall levers are: OR-in synonyms and concrete instances (the index only knows the words in the files; a note about a specific tool rarely names its category), raise `--k` (a row costs tens of tokens), and widen the scope (`--preset`, or `--include` for an ad-hoc glob). Vector rows already cover the meaning-over-words gap by default. Each widening adds candidates and dilutes ranking, so the noise trade-off runs both ways.
- A frontmatter query enumerates its matches deterministically; search ranks by term overlap, so results shift as phrasing shifts. Trade-off: a query needs a known field, search doesn't.
- The `via` column says what produced each row: `match` (words hit), `link` (connected to notes that hit), `vector` (near in meaning), and combinations. The `lines` column, when set, points at the section that earned the row (the best-matching chunk on vector rows, the term cluster's section on large lexical notes) and is a direct `Read` range; null means the whole note is the reference.
- Scope is one vocabulary shared by `search`, `map`, `peek`, `path`, and `related`: bare command uses the config's `default` preset; `--preset <name>` picks another (unknown names error, listing what's declared); `--include <glob>` and `--exclude <glob>` are ad-hoc globs for one command, each overriding its own side of the preset, so one does not clear the other; `--no-exclude` drops the preset's `exclude` for one command, the only way to widen past it without editing config (it widens the query scope, not the index: a file no preset covers is never indexed). `--where` takes any SQL condition against frontmatter alias `f`, not only field equality: `"f.status = 'active' AND has(f.tags, 'x')"`, `"datetime(f.created) >= datetime(?)"`. There is no whole-index flag: a broad `default` preset, or a declared `all` preset (`include ["**/*"]`), is the whole tree. `sense status` shows every preset with its coverage. `sql` scopes differently: it runs over the whole index by default, and `--preset <name>` *binds* the scope as a temporary `scope(path)` table your statement joins, rather than filtering behind the query's back (`JOIN scope ON scope."path" = f.path`). Naming a preset without joining `scope` is a usage error, since it would return everything while reading as scoped. Without the flag, join `preset_files` directly, which is the same coverage under a preset name you write into the SQL.
- `score` is a rank-fusion value: it ranks rows within one result set and is not comparable across queries, not a relevance magnitude. It encodes how many signals fired and at what rank, so a perfect lexical hit and a weak vector-only hit can read the same number. With vectors active, rows carry `similarity`: the cosine (-1 to 1) of the query against that file's best-matching chunk (the same chunk the `lines` range points at). It orders vector evidence within a result set; the range it spans depends on the corpus and the embedding model, and compresses on small trees, where even a nonsense query has a moderately near neighbour somewhere. Compare similarities within a result set rather than against a fixed cutoff carried between trees.
- Absence evidence lives in the labels: a `semantic: false` preset (or a tree with no `embed` block) returns 0 rows when the words are nowhere in it. Default `search` always returns up to `k` rows (nearest-neighbour search has a nearest neighbour for any input), so a result of only `via: vector` rows IS the absence signal for the words themselves; `similarity` and the snippet are the evidence for judging whether a vector row is a real conceptual hit.
- A `queries` entry names the verb it runs, mirroring the two commands: `"dead-links": { "sql": "SELECT src, target FROM links WHERE dst IS NULL AND lower(target) NOT GLOB '*.[a-z0-9]*'" }` runs as `sense dead-links`, and `"hot": { "search": "pricing OR billing", "preset": "raw", "k": 20 }` runs as `sense hot` with its settings baked in, so repeat runs need no flags. An invocation-level `--preset`, `--k`, or `--where` overrides a saved search's value; `--list` labels each entry `(sql)` or `(search)`.
- Running an entry is how it is validated: a typo'd column, stale SQL, bad FTS5 syntax or an unknown preset errors and exits nonzero. A parameterised entry validates with any argument, since SQL is prepared before parameters bind (`sense by-tag zzz` reports `no such column` if the column is wrong, `(0 rows)` if it is right). To sweep a whole config after editing it, read the exit code: 0 ran, 2 means it needs parameters (re-run it with any argument to validate the SQL), anything else is broken.

```sh
for q in $(sense --list | awk '{print $1}'); do
  sense "$q" --format json >/dev/null 2>&1
  case $? in 0) ;; 2) echo "needs an argument: $q" ;; *) echo "broken: $q" ;; esac
done
```

  Whether an empty result is good or bad is the reader's judgment: a dead-link query returning rows means broken citations to fix.

## SQL

The commands are shorthands over those tables; anything they don't express, SQL does.

```
sense sql "SELECT name FROM pragma_table_info('frontmatter')"          # what fields exist
sense sql "SELECT DISTINCT status FROM frontmatter"                    # what values a field takes
sense sql "SELECT src FROM links WHERE dst = ?" notes/pricing-model.md  # backlinks
sense sql "SELECT f.path FROM frontmatter f JOIN scope ON scope.path = f.path" --preset default   # scope SQL to a preset
sense sql "SELECT f.path FROM frontmatter f JOIN preset_files p ON p.path = f.path AND p.preset = 'default'"  # the same, preset named in the SQL
sense sql "SELECT path FROM frontmatter WHERE path NOT IN (SELECT dst FROM links WHERE dst IS NOT NULL) AND path NOT IN (SELECT src FROM links)"  # linked neither way (fine if intentional; linking is optional)
sense sql "SELECT src, target FROM links WHERE dst IS NULL AND lower(target) NOT GLOB '*.[a-z0-9]*'"  # broken wikilinks, attachments excluded
sense sql "SELECT heading, start_line, tokens FROM sections WHERE path = ?" a.md   # budget a read
sense sql "SELECT j.value, COUNT(*) n FROM frontmatter, json_each(frontmatter.tags) j GROUP BY j.value ORDER BY n DESC"   # count per array member
```

`path` covers the route between two notes, and `search`'s `via: link` rows are the ranked neighborhood around a query; a structural k-hop walk is a bounded `WITH RECURSIVE` over `links`. Bound the depth: an unbounded walk on a densely linked tree enumerates paths exponentially. Pass these through `sense sql "<sql>" <seed>` or save as `{ "sql": "..." }`.

```
-- notes within 2 hops of a seed, links both ways (UNION dedups, so it terminates)
WITH RECURSIVE hop(path, d) AS (
  SELECT ?, 0
  UNION
  SELECT CASE WHEN l.src = hop.path THEN l.dst ELSE l.src END, hop.d + 1
  FROM hop JOIN links l ON (l.src = hop.path OR l.dst = hop.path) AND l.dst IS NOT NULL
  WHERE hop.d < 2
)
SELECT DISTINCT path FROM hop WHERE d > 0;

-- notes cited alongside a seed: they share a note that links to both (co-citation)
SELECT DISTINCT b.dst FROM links a JOIN links b ON a.src = b.src
WHERE a.dst = ? AND b.dst IS NOT NULL AND b.dst <> a.dst;
```

- A saved `{ sql }` written against `scope` is preset-agnostic: `sense <name> --preset raw` re-points the same statement at another layer, so one entry serves every preset instead of one copy each.
- `content MATCH` only works against the fts5 table by its own name, never through an alias or a view: `FROM content c ... WHERE c MATCH 'x'` fails with `no such column: c`. This is why `--preset` binds a table to join rather than shadowing the tables.
- `content MATCH` takes FTS5 syntax: `a OR b`, `"phrase"`, `pref*`, `NEAR(a b, 5)`, `summary: term`. Stemmed; markdown stripped at index time. Double-quote any term with punctuation. Bare `customer-facing` errors (`-` reads as a column filter), bare apostrophes are syntax errors: write `"customer-facing"`, `"founder's"`.
- Rank with `ORDER BY bm25(content, 10.0, 5.0, 1.0)` (title > summary > body); excerpt with `snippet(content, -1, '«', '»', '…', 10)`. snippet() re-tokenizes each matched doc and its cost grows superlinearly with doc size, measured ~10 s per query on a tree holding one 1 MB note. `search` bounds this itself (docs past 16 KB get an equivalent excerpt another way); in hand-written SQL, guard it: `CASE WHEN length(text) <= 16384 THEN snippet(...) END`, or select `title`/`summary` instead of an excerpt.
- Select `content.title`/`content.summary` (always exist, empty when absent) rather than `f.title`/`f.summary` (discovered columns; error on trees that never declare them).
- Frontmatter values keep their YAML type: strings are TEXT, whole numbers and booleans are INTEGER (`true` stores as 1, so `WHERE flag = 1` matches and `WHERE flag = 'true'` matches nothing), fractions are REAL, lists and maps are JSON text. `map` prints the observed type per field, and a field showing two types (`integer,text`) has drifted across notes.
- **Dead links need the attachment filter.** `dst IS NULL` alone is not "broken link": a wikilink to anything that is not markdown (`[[Board.base]]`, `![[Pasted image.png]]`, `[[spec.pdf]]`) can never resolve, because sense indexes markdown and resolution only tries the exact path or `+.md`. Those are out of the index's universe, not broken. On a 1,400-note Obsidian vault the unfiltered query returns 143 rows where 14 are real. Exclude anything carrying a file extension, as in the recipe above, and widen the exclusion if your notes have dotted titles (`[[Node.js]]` carries one too, so a stricter list -- `'*.png'`, `'*.pdf'`, `'*.base'`, and whatever else your vault attaches -- is safer on a tree whose titles use dots). Scope it with `preset_files` as well: template and skill files are full of `[[Note Name]]` examples that are deliberately unresolved.
- `has(field, value)`: array membership on JSON-array fields, substring on strings, false on NULL. This is the `includes()` convention. Substring means `has(f.status, 'active')` also matches `inactive`; exact scalar match is `f.status = ?`, deliberate substring is `LIKE`, exact array membership is `EXISTS (SELECT 1 FROM json_each(f.tags) WHERE value = ?)`. To aggregate per member instead, use `json_each(frontmatter.<field>)` (above) -- GROUP BY on the raw column splits `["a","b"]` and `["b","a"]` into separate buckets.
- Date fields are stored as written. Compare through `datetime()`, which normalizes ISO 8601 timezone offsets to UTC: `WHERE datetime(created) >= datetime(?)`. Bare string comparison is only safe when every note uses the same offset.
- Date spellings SQLite rejects (`-0800`, `-08`, a space separator) are normalized at index time, offset preserved. One it cannot fix is left as written and warned about by path: `datetime()` returns NULL there, so the row is invisible to a date comparison rather than excluded by it. List them with `WHERE d IS NOT NULL AND datetime(d) IS NULL`.
- **SQLite's `now` is UTC, so any query about "today" needs `'localtime'`.** `date('now')` reads as tomorrow from mid-afternoon onward in the Americas, which silently flips "scheduled today" into "overdue" every evening: write `date('now','localtime')` and `datetime('now','start of day','localtime')`. This only matters where the boundary carries the meaning; a `'-90 day'` window is unaffected by a few hours of skew.
- To bound what a query puts into context: `snippet()` excerpts just the matching text, `LIMIT` caps row counts, and selecting `path`/`title`/`summary` keeps rows small. `SELECT text FROM content` returns the tree's entire prose (sense warns past 50 KB). Aggregates (`COUNT`, `GROUP BY`) are already bounded. `SELECT * FROM frontmatter` is always safe: prose is not a frontmatter column.

Worked traces: [EXAMPLES.md](EXAMPLES.md).

## Setup and upkeep

- Missing CLI: `npm install -g sensemaking`. Missing config: `sense init` at the tree root. Discovery walks up from cwd; `--config <path>` overrides. Setting up or restructuring a tree (presets, frontmatter conventions, note design) is the `sense-setup` skill.
- `map` and `status` report each preset's coverage (files matched, embedded count). Indexing derives from presets, so the coverage numbers are how you see what a config actually indexes and embeds. A scope with fewer signals just uses fewer (a semantic-off preset searches lexically); a saved search naming an unknown preset errors when run, listing the declared ones.
- Save a query into `sense.config.json` only when it will be reused; run ad-hoc otherwise.
- A one-line `summary:` per note is optional and pays twice: it appears in result rows and is a weighted search field. Date comparisons work for dates written as ISO 8601 (`2026-08-12`, or with time and offset), the only format `datetime()` parses. Field names in examples (`status`, `tags`, `created`) are illustrative; your tree defines its own.
- Reserved frontmatter keys (dropped with a warning): `path`, `_mtime`, `_size`, `_rank`, `_parse_error`, `content`, `links`, `sections`.
- A note whose frontmatter does not parse is indexed with **no** frontmatter columns and `_parse_error` set to the YAML message, which carries the line. Nothing is half-recovered: a non-NULL value is a value the author wrote. So a NULL column means the key was absent *or* the note did not parse, and `_parse_error` is how you tell: `WHERE status IS NULL AND _parse_error IS NULL` is "genuinely missing status". List what needs fixing with `sense sql "SELECT path, _parse_error FROM frontmatter WHERE _parse_error IS NOT NULL"`; fixing a file clears it on the next command. `sense status` reports the count.
- Exit codes: `0` ok, `1` error (SQLite message verbatim), `2` usage (unknown query, wrong param count).
- Doubted cache: delete the directory `sense status` prints on its `cache:` line. Rarely needed; every query reconciles first.
