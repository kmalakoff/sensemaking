# Changelog

All notable changes to sensemaking are documented here.

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
