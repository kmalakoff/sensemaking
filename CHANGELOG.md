# Changelog

All notable changes to sensemaking are documented here.

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
