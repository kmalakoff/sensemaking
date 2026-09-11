# Turso query guide

Read this guide when `store` is `turso`.

Sense stores the cache at `.sense/cache.turso.db` and uses `@tursodatabase/database` with Tantivy full-text indexes. Use this experimental adapter when the tree benefits from the embedded Turso engine or its text-index behavior.

The first open installs the native package if needed. Turso holds the cache file for the connection's lifetime, so another Sense command waits for the current command or watcher cycle to close it. The upstream engine supports more deployment and concurrency options than this adapter currently exposes. Sense opens a local file and does not configure sync, remote access, concurrent writers, or encryption.

## `sense search` grammar

Bare words and quoted phrases work. Sense applies shared stemming and joins bare words with AND. It verifies phrases against authored text and uses n-gram sidecars for unspaced scripts.

The portable search command does not accept FTS5 prefix, boolean, `NEAR`, initial-token or boost, column-filter, or grouping operators. Examples include `foo*`, `a OR b`, `NEAR(a b)`, `^term`, `title:term`, and `(a b)`. Sense raises `STORE_CAPABILITY_MISSING` instead of passing those forms to Tantivy.

To express alternatives, run separate bounded searches and combine the paths, or use a frontmatter filter when the distinction is structured.

## Raw text search

`content` is a regular table with store-owned stem and n-gram columns. SQLite's `content MATCH`, `snippet()`, and `bm25()` do not run here. Use `sense search` for ranked text retrieval.

Turso exposes native `fts_match()` and `fts_score()`, but their valid scoring forms depend on the exact index projection. Sense owns those calls so that scores do not silently flatten. Saved queries should not call the store-owned text indexes.

## Functions and types

`has()` and `basename()` work in raw SQL. Sense rewrites them into portable SQL because the client cannot register user-defined functions. Nested calls and placeholders are supported.

`segment()` is unavailable. A query that calls it raises `STORE_CAPABILITY_MISSING`. `sense search` still handles unspaced scripts without it.

Turso follows SQLite syntax for common date and JSON operations. Use `datetime()` for ISO 8601 comparisons and add `localtime` when a calendar-day query means the machine's local day:

```sql
WHERE datetime(created) >= datetime(?)
WHERE date(created) = date('now', 'localtime')
```

Frontmatter lists and maps are stored as JSON text and can be expanded with `json_each()`.
