# Choose DuckDB

Choose DuckDB when the cache file is an analytical artifact that another DuckDB tool will query, when saved SQL needs DuckDB's types and functions, or when the cache belongs beside large local or cloud datasets.

DuckDB is designed for analytical SQL and supports larger-than-memory work by spilling to disk. Its SQL closely follows PostgreSQL while keeping documented differences and extensions. See the official [DuckDB performance guide](https://duckdb.org/docs/current/guides/performance/how_to_tune_workloads) and [SQL introduction](https://duckdb.org/docs/current/sql/introduction).

Sense's [store benchmark summary](../store-benchmarks.md) measures the current adapter paths on a named markdown tree. It does not measure DuckDB's general analytical ceiling. Use it when current Sense latency matters to the choice.

## What the choice gives you

- A standard `.sense/cache.duckdb` database that DuckDB tools can open.
- Frontmatter in `VARIANT` columns, so lists, maps, booleans, numbers, and strings retain useful native shapes.
- Embeddings in native fixed-width float arrays.
- DuckDB SQL for downstream analysis.
- Compatibility with external DuckDB workflows. MotherDuck supports hybrid queries over local and cloud data, although Sense does not connect, upload, or replicate the cache for you. See [MotherDuck's hybrid execution overview](https://motherduck.com/research/motherduck-duckdb-in-the-cloud-and-in-the-client/).

## Current Sense adapter boundaries

- DuckDB support is experimental.
- The first open installs `@duckdb/node-api`, with a native download of about 110 MB.
- DuckDB holds the cache file for the life of a connection. Concurrent sense commands wait for the current command or watcher cycle to close it.
- `sense search` accepts bare words and quoted phrases. It rejects FTS5 boolean, prefix, `NEAR`, initial-token, grouping, and column-filter syntax.
- SQLite's raw `MATCH`, `snippet()`, and `bm25()` queries do not port.
- Mixed-type `VARIANT` fields can require explicit casts in predicates.

Commands, public tables, `has()`, `basename()`, `segment()`, vectors, and `sense watch` remain available. Read the [DuckDB query guide](../../../sense/references/stores/duckdb.md) before translating saved SQL or advanced searches.

Changing to DuckDB builds its separate cache. It does not migrate the SQLite or Turso cache.
