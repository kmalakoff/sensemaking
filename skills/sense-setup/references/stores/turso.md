# Choose Turso

Choose Turso when the tree benefits from the embedded Turso Database engine or its Tantivy text index, or when evaluating the engine as the Sense adapter evolves. The Sense adapter is experimental; the engine is a fast-moving Rust rewrite of SQLite whose trade-offs can change between releases.

Upstream Turso offers async I/O and concurrent writes in its local engine, plus sync through a separate SDK. Sense currently opens one local cache through `@tursodatabase/database` and serializes Sense commands against that file. It does not configure sync, remote access, or encryption. Read [Turso's current SDK guide](https://docs.turso.tech/sdk/introduction) to distinguish engine capabilities from the adapter features Sense exposes.

## What the choice gives you

- A `.sense/cache.turso.db` file using the embedded Turso engine.
- Tantivy-backed lexical ranking with shared stemming and n-gram support for unspaced scripts.
- The asynchronous JavaScript database client used by sense's store adapter.
- Native vector storage and search.

## Current Sense adapter boundaries

- Turso support is experimental.
- The first open installs the optional native package.
- Turso holds the cache file for the life of a connection. Concurrent sense commands wait for the current command or watcher cycle to close it.
- `sense search` accepts bare words and quoted phrases. It rejects FTS5 boolean, prefix, `NEAR`, initial-token, grouping, and column-filter syntax.
- SQLite's raw `MATCH`, `snippet()`, and `bm25()` queries do not port.
- `has()` and `basename()` work through SQL rewriting. `segment()` is unavailable.

Commands, public tables, vectors, and `sense watch` remain available. Read the [Turso query guide](../../../sense/references/stores/turso.md) before translating saved SQL or advanced searches.

Changing to Turso builds its separate cache. It does not migrate the SQLite or DuckDB cache. Review the shipped [store benchmark summary](../store-benchmarks.md) if performance affects the choice.
