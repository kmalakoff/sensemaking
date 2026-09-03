# Changelog

All notable changes to sensemaking are documented here.

## [0.22.1] - 2026-09-04

### Changed

- duckdb cold builds are faster. Every bulk insert now goes through the engine's appender, not
  only the frontmatter rows: link, section and tag tables, preset membership and the text index.
  On the 6,566-note hub corpus a cold build went from 4,051 ms to 2,539 ms, with the link and
  section writes falling from about 650 ms each to about 55. sqlite and turso are unchanged.

## [0.22.0] - 2026-09-04

### Added

- `open()` reports where a cold index build spent its time. The result carries per-stage wall time
  for the work a build does: listing files, parsing them, writing frontmatter, building the text
  index, applying presets, and each feature's own hooks. Stage names describe work rather than the
  code doing it, and the set is a function of config alone, so a cold build and an incremental one
  report the same keys. The span names are diagnostic and are versioned by `STAGES_VERSION`, which
  is `s1`; treat a change in that marker as a change in the vocabulary. A build with no timers
  reports nothing rather than zeros.

### Known limitations

- `sense search` with a boolean `OR` still works only on sqlite. duckdb and turso refuse it, naming
  the gap. This is unchanged in this release and is recorded here because benchmarking found it: a
  query a user would expect to work everywhere works on one store of three.

### Fixed

- `sense watch` runs on duckdb and turso. It used to refuse both, because it held the store open
  for its whole run and those engines give the cache file to one process at a time, so every other
  command on the tree failed while a watcher ran. The watcher now opens, reconciles and closes on
  each change and holds nothing in between, at about 7 ms per change. A command that finds the file
  held waits for as long as that tree's longest recorded rebuild, not a fixed five seconds, and then
  says which process has it.

### Changed

- Commands start faster. Three `Intl.Segmenter` objects were built when their module loaded, one
  for graphemes and two for sentences and words, so every command that reached the chunking code
  paid for all three even when it used none of them. Each is now built on first use and kept.
  Whole-invocation compile time on the built package went from 28.9 ms to 21.5 ms over three
  repeats.

## [0.21.1] - 2026-09-03

### Changed

- Markdown parsing loads its parser on first use rather than when the module loads, so a command
  that never parses a file does not pay for the parser at all.
- Building a duckdb index writes frontmatter rows through the engine's bulk appender instead of
  binding each value as a parameter. Cost had scaled with the number of columns, since every
  parameter was bound individually. Type fidelity is unchanged.

## [0.21.0] - 2026-09-02

### Removed

- `content.tokenize` is gone, and a config that still sets it fails to load with a message naming the removal rather than being migrated silently. It passed a raw SQLite FTS5 tokenizer string straight into the DDL, so it did something on sqlite and nothing at all on duckdb or turso: it never worked as a portable setting. Every outcome it selected is now automatic on all three stores, so removing the `content` block is the whole fix, and doing so rebuilds the index under the current tokenizer.

### Fixed

- Two `sense` commands running at the same moment on one tree could fail. On duckdb and turso, all but one failed at open with the engine's own lock error, warm trees as well as cold, because both hold the cache file for a connection's whole life rather than for a transaction; a command now waits for the holder to finish, up to five seconds, and past that says which store serves concurrent commands instead of repeating the engine's message. On sqlite the failure was cold-build only and had a different cause: two processes each classified the same file as new from a read taken before the write lock, and the second then collided with the first's row. That classification is now rechecked once the lock is held.
- `has()`, `basename()` and `segment()` on a turso tree reported the engine's `no such function`, which reads as a typo in valid sense SQL. They now name the gap and the stores that have it, and for `has()` hand over the equivalent plain SQL, since turso can express it. A function sense never supplies still gets the engine's message.

### Changed

- A config change now invalidates what it affects instead of clearing the whole cache. Editing a preset glob, swapping the embed model, changing `chunkTokens`, or toggling a feature (tags, sections, links, rank) each narrow to the rows they touch, so a preset edit no longer re-embeds a tree that did not change. The rebuild notice names which segment moved.
- Link resolution re-resolves only what a change could have affected, unless the build is cold. The previous rule handed a fifth of the tree changing to the slower whole-table pass, which cost more than the incremental path at every churn level short of a rebuild. Output is unchanged.

## [0.20.0] - 2026-08-30

### Changed

- The exported `Store` shape changes, with no shim: `reconcile()` is no longer on `Store`, which now answers queries only. Bringing the index current is internal to the package, with no public replacement. Reconcile happens in `open()`, so a CLI invocation is always current because each one opens fresh; a library consumer holding a store from `open()` is not, and calls `open(cfg)` again to get a current one. There is no in-place refresh for a store already held. The internal path also got faster for the watcher: `sense watch` reuses one parse worker pool across its whole lifetime instead of creating and destroying a pool on every tick and paying 85-100 ms of pool startup each time.
- A change to the embedding model that only moves its resolved identity no longer clears the duckdb or turso cache and re-embeds every chunk; the new identity is adopted in meta in place. The behaviour was previously sqlite-only.
- When a config change forces a rebuild, all three stores name which config segment moved, instead of reporting a generic rebuild reason.

### Fixed

- Hidden comment text no longer leaks into the index. A `%%...%%` comment split by a blank line, and an inline `<!-- -->` comment opened in one paragraph and closed in a later one, were indexed with their markers while Obsidian hides them. Text extraction now resolves sibling blocks in one pass with code held out of it, so a `%%` inside a fenced block stays literal. Cache schema versions bump on all three stores (sqlite 18 to 19, duckdb 2 to 3, turso 3 to 4), so an existing tree rebuilds on its first query after the upgrade, and an embed tree re-embeds as it does.

## [0.19.2] - 2026-08-30

### Added

- `CAPABILITY_NAMES` joins the exported `Capability` type, so a consumer can enumerate the capabilities a store may declare instead of hard-coding them. It gains a sixth member, `sql-functions`, naming whether an engine can register `has`/`basename`/`segment` as SQL functions at all, which turso's client cannot. The gap itself is unchanged and was already declared in 0.19.0; it is now a named capability rather than a hand-written store list, and no store's behaviour changes.

### Fixed

- `sense map` on a duckdb tree with many frontmatter fields was slow out of proportion to the tree. The field-type scan issued one query carrying a `string_agg(DISTINCT variant_typeof(...))` aggregate per column, and duckdb degrades superlinearly in the number of such aggregates in a single projection rather than in the column count: at 301 columns that query cost 1148 ms, against 10 ms for `COUNT` over the same columns. The scan now runs in chunks of 16 aggregates, taking those 301 columns to 81 ms and the whole command from 1773 ms to 116 ms. A 31-column tree improves too, 17 ms to 11 ms. sqlite and turso were never affected: `GROUP_CONCAT` over 300 columns runs in 7 ms.

## [0.19.1] - 2026-08-30

### Fixed

- A turso tree took 945 seconds to index the 6,566-note benchmark corpus and could not finish a 13k one at all. Turso maintains its full-text index on every inserted row, doing work proportional to what is already indexed, so a cold build was quadratic in note count. A bulk build now writes the rows first and builds the index once afterwards, inside the same transaction: the same corpus indexes in 3.3 seconds and the index on disk drops from 61.5 MB to 27 MB. Incremental edits are unchanged, keeping the index in place below a measured threshold of 250 changed files, above which rebuilding is cheaper than maintaining.
- Two `sense` commands starting at the same moment on a tree with no index yet could fail with `database is locked` or `duplicate column name`. The busy timeout was applied after the WAL conversion it needed to cover, and both schema setup and the frontmatter column discovery read the column list before the write transaction they then altered inside. Commands on an existing index were unaffected.

## [0.19.0] - 2026-08-30

### Added

- `turso` joins `sqlite` and `duckdb` as a `store` option. The first command that opens a turso tree installs `@tursodatabase/database` on its own. Lexical search is Tantivy rather than FTS5, with an ngram-tokenized sidecar index serving Chinese, Japanese, Thai, Khmer, Lao, and Burmese; a quoted hyphenated phrase (`"customer-facing"`) matches the same notes it does on sqlite, where duckdb diverges. Vectors are native `F32_BLOB` columns. Two gaps are declared, not silent: `has`/`basename`/`segment` are not available (the client cannot register SQL functions), and `sense watch` errors at start, as it does on duckdb.

### Changed

- `sense status` reports the embedding model's language fit as one of five states rather than one line: declared in `embed.languages`, declared by the model card, none declared by the card, unresolved because the card could not be read, or absent for a local-path model, which has no card by design. In JSON, `languages` keeps its shape and a `languagesState` field names which of those applies.
- A file that changed is parsed once per index pass rather than twice. Reconcile already parsed it to work out its chunk boundaries, and the embedding step then re-read and re-parsed the same file to recover the chunk text; it now takes that text from reconcile directly. Vectors are byte-identical. The second parse still happens when the two steps run in different commands (`sense map` today, `sense search` tomorrow, or indexing done by a background `sense watch`), and only for the files that actually changed.
- The heading outline for the `sections` table is built from the parse that already ran, instead of walking every line a second time with a separate fence tracker. The table is byte-identical, including for indented fences, where the two fence rules could have disagreed.

### Fixed

- A model card that could not be read failed silently, leaving the language-fit check off with nothing said. It now prints one line naming the consequence and the fix, and still retries on the next run. The check is what makes a default English model safe on a tree in another language, so its failure being quiet was the problem.

## [0.18.4] - 2026-08-30

### Fixed

- Under duckdb, a search combining a bare word with a quoted phrase or an unspaced-script (CJK) run bound its query parameters one position out of step, so `telescope 北京` returned no rows and `apple "fruit salad"` returned notes without "apple". Each half of such a query was already correct on its own.

## [0.18.3] - 2026-08-30

### Changed

- `sense status` prints engine settings as a per-store block rather than a hard-coded sqlite line; in JSON, `busyTimeoutMs` is replaced by an `engine` object keyed by whatever that store reports. On sqlite the same `busy_timeout` value still appears, now as `engine.busy_timeout`.
- `sense.config.json` is written stage-then-swap, so an interrupted `sense init` or config migration leaves the existing file intact instead of truncated.

### Fixed

- `sense map` reported `VARIANT` as the observed type of every frontmatter field under duckdb, since duckdb boxes those columns; it now reports the same `integer`/`real`/`text` vocabulary sqlite does. On both stores a multi-type field's types now print in a stable sorted order.

## [0.18.2] - 2026-08-29

### Changed

- Cold builds parse in parallel on trees of 200 files or more, across a worker pool sized to the machine (capped at 8). On the 6,566-file benchmark corpus a cold crawl goes from 7102 ms to 2504 ms, and the in-process index build from 5985 ms to 2351 ms. Smaller trees are unchanged: below 200 files the serial path still runs, because the pool costs more than it saves there. A bulk sync crosses the same threshold, so re-indexing 500 changed files drops from 1094 ms to 648 ms. Output is unchanged: document order, warnings, frontmatter column order and search ranking are byte-identical to the serial path, and both retrieval-quality corpora score identically on bm25.

### Fixed

- `sense watch` could exit while a reconcile was still running, so the last set of changes went unreported. Shutdown now waits for an in-flight reconcile before closing the store.

## [0.18.1] - 2026-08-29

### Fixed

- `sense watch` on a duckdb tree appeared to work and held the cache file lock against every other command for its lifetime; it now errors at start, naming the fix (`store` to `sqlite`).
- `status` reported the SQLite cache schema version on duckdb trees; it now reports the version the cache was built with.
- The SQL column-quoting hint (punctuated frontmatter keys) now fires on duckdb trees, whose binder error names the fragment differently.

## [0.18.0] - 2026-08-29

### Added

- `store` config key: `sqlite` (default, zero-dependency, Node's built-in SQLite) or `duckdb` (experimental). Each store keeps its own cache file (`.sense/cache.db`, `.sense/cache.duckdb`); switching stores is a rebuild, not a migration.
- DuckDB store: the same commands, tables, and `has`/`basename`/`segment` functions. The first command that opens a duckdb tree installs `@duckdb/node-api` on its own (a one-time native download, ~110 MB). Under duckdb, FTS5 operator forms (`foo*`, `AND`/`OR`/`NOT`, `NEAR`, `^`, `title:foo`) are a named error (STORE_CAPABILITY_MISSING) that says how to rephrase or set `store` to `sqlite`; bare words and quoted phrases work on both.
- DuckDB lexical search: BM25 ranking through the fts extension, with `contains()` substring matching for unspaced scripts.
- DuckDB vector search: native `array_cosine_similarity` over `FLOAT[dims]`.

### Changed

- `status` reports the store, both cache locations, and the derived values that depend on it.
- JSON output is bigint-safe on both stores.

### Fixed

- `map`, `search`, and `path` returned empty under the duckdb store (json_each scope).
- Scores and similarities printed with full float precision under duckdb (REAL is a 4-byte float there; the temp table is now DOUBLE).

## [0.17.1] - 2026-08-28

### Fixed

- Language distribution is lazy-loaded, off every command's module graph.

## [0.17.0] - 2026-08-28

### Added

- mdast-based markdown chunking: bounded paragraph-group chunks with sentence/word CJK splitting; `embed.chunkTokens` lowers the cap for small-context models.
- `benchmark/oracle.mjs`: Obsidian metadataCache parity gate for tags, links, and block extents.
- Benchmark restructure: per-sitting reports with queryable frontmatter, methodology changelog, numbers-of-record table (history recovered to 0.3.0).

### Changed

- The words layer reads from AST extraction; remove-markdown is gone.
- GFM extensions updated, tokenizer usage streamlined, language classification improved.

## [0.16.0] - 2026-08-27

### Added

- Embedding overhaul: `static`/`openai`/`cohere` providers with live-endpoint suites, per-preset weighted `signals`, language-fit errors (EMBED_MODEL_MISMATCH), and the Hugging Face model cache in `~/.sense/models`.
- `Intl.Segmenter` grapheme handling for unspaced scripts.
- Footnote text is indexed.

## [0.15.4] - 2026-08-23

### Changed

- Dependency updates.

## [0.15.3] - 2026-08-23

### Changed

- Unified region masking: HTML blocks swallow links, unclosed comments die at block end, one-line type-1 blocks close.

## [0.15.2] - 2026-08-23

### Changed

- URI schemes are external link destinations; wikilink inner parsing is shared; comment-in-block behavior is pinned.

## [0.15.1] - 2026-08-23

### Changed

- Match Obsidian's link graph: region masking, frontmatter links, markdown linkpath semantics, tiebreaks; parity gate for links.

## [0.15.0] - 2026-08-23

### Changed

- CommonMark fence and HTML-block semantics in tag extraction.
- Obsidian parity gate added to the release process.

## [0.14.0] - 2026-08-23

### Fixed

- Tag false positives from wikilinks and HTML spans.
- Wikilinks parse to the first `]]`.

### Changed

- Punctuated column names get a quoted-form hint on error.

## [0.13.2] - 2026-08-23

### Fixed

- Per-row edge semantics restored in linkEdges.

## [0.13.1] - 2026-08-22

### Fixed

- sense-bases translations: `isEmpty()`'s four empty shapes, `isType` via json_each's `type` column, chained-formula CTE guidance.

## [0.13.0] - 2026-08-22

### Added

- `tags` table, link embed flag, `_ctime` column, `basename()` SQL function, and the sense-bases skill.

## [0.12.2] - 2026-08-22

### Changed

- FTS5 punctuation errors explain the fix.
