# DuckDB query guide

Read this guide when `store` is `duckdb`.

Sense stores the cache at `.sense/cache.duckdb`. It is a DuckDB database file with frontmatter values in `VARIANT` columns and embeddings in native fixed-width float arrays. Use this store when another DuckDB tool needs to inspect or analyze the cache.

The first open installs `@duckdb/node-api` if needed. Its native download is about 110 MB. DuckDB holds the cache file for the connection's lifetime, so another sense command waits for the current command or watcher cycle to close it.

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

DuckDB has its own date, JSON, list, and casting syntax. Use DuckDB SQL rather than copying SQLite functions into a saved query. For ISO 8601 timestamps with offsets, cast to `TIMESTAMPTZ` before comparing:

```sql
WHERE created::TIMESTAMPTZ >= ?::TIMESTAMPTZ
```

DuckDB's dialect closely follows PostgreSQL but has documented differences and its own extensions. Read the official [DuckDB SQL introduction](https://duckdb.org/docs/current/sql/introduction) for engine SQL. Queries written with DuckDB-only syntax stay tied to this store.
