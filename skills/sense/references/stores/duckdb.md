# DuckDB query guide

Read this guide when `store` is `duckdb`.

Sense stores the cache at `.sense/cache.duckdb`. It is a DuckDB database file with frontmatter values in `VARIANT` columns and embeddings in native fixed-width float arrays. Use this store when another DuckDB tool needs to inspect or analyze the cache.

The first open installs `@duckdb/node-api` if needed, at the newest version in sensemaking's declared range. Its native install is about 60 to 100 MB depending on platform. DuckDB 1.5 and 2.0 are both tested through the CLI suite, and the cache stays readable by DuckDB 1.5. Each DuckDB version downloads its `fts` extension into `~/.duckdb/extensions/<version>/` on its first index build. A build after the installed version changes rebuilds the cache, and a no-build query on that cache fails with `INDEX_NOT_READY` until it does. Under DuckDB's [concurrency model](https://duckdb.org/docs/current/connect/concurrency), Sense opens an existing cache for no-build observation in read-only mode, so several independent reader processes can coexist. A build-enabled command or watcher opens it read-write and excludes every other process until it closes. Contenders wait within Sense's bounded lock budget, then fail with `STORE_BUSY`. This cross-process rule does not promise writer/reader coexistence or unrestricted sharing by independently configured DuckDB instances in one process.

## `sense search` grammar

Bare words and quoted phrases work. Bare words are joined with AND, and phrases are verified against authored text.

The portable search command does not accept FTS5 prefix, boolean, `NEAR`, initial-token, column-filter, or grouping operators. Examples include `foo*`, `a OR b`, `NEAR(a b)`, `^term`, `title:term`, and `(a b)`. Sense raises `STORE_CAPABILITY_MISSING` instead of interpreting them as literals.

To express alternatives, run separate bounded searches and combine the paths, or use a frontmatter filter when the distinction is structured.

## Raw text search

`content` is a plain table. SQLite's `content MATCH`, `snippet()`, and `bm25()` do not run here. Use `sense search` for ranked text retrieval and combine it with `--where` for frontmatter filters.

DuckDB maintains its own native FTS index for the search command. Its generated index name and scoring adapter are implementation details. Saved queries should not call them.

## Functions and types

`has()`, `basename()`, and `segment()` are registered SQL functions. `segment()` is available for portable saved queries, although `sense search` already handles unspaced scripts.

Frontmatter columns use DuckDB `VARIANT`. Homogeneous values compare normally. A numeric comparison against a field that contains numbers in some notes and text in others can raise a type error. Check `sense map` for mixed observed types before writing the predicate.

DuckDB has its own date, JSON, list, and casting syntax. Use DuckDB SQL rather than copying SQLite functions into a saved query. Write lambdas as `lambda x: ...`, which runs on DuckDB 1.5 and 2.0; the `x -> ...` form fails under DuckDB 2:

```sql duckdb
SELECT list_transform([1, 2], lambda x: x + 1) AS next;
```

For ISO 8601 timestamps with offsets, cast to `TIMESTAMPTZ` before comparing:

```sql duckdb
SELECT path FROM frontmatter WHERE created::TIMESTAMPTZ >= ?::TIMESTAMPTZ ORDER BY path;
```

DuckDB's dialect closely follows PostgreSQL but has documented differences and its own extensions. Read the official [DuckDB SQL introduction](https://duckdb.org/docs/current/sql/introduction) for engine SQL. Queries written with DuckDB-only syntax stay tied to this store.
