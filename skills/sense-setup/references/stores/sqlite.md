# Choose SQLite

SQLite is the default recommendation for a sense tree.

Choose it when the tree has no engine-specific requirement, when saved searches use FTS5 operators, or when people and agents may run sense commands at the same time.

## What the choice gives you

- No optional store package. Sense uses Node's built-in SQLite.
- The full documented word-search grammar, including boolean, prefix, `NEAR`, initial-token, grouping, and column-filter expressions.
- Raw FTS5 SQL through `MATCH`, `bm25()`, and `snippet()`.
- The sense SQL functions `has()`, `basename()`, and `segment()`.
- WAL-backed concurrent sense commands.

The cache is `.sense/cache.db`. It is derived data and can be rebuilt from the markdown files.

## When another store fits the workflow

Use DuckDB when downstream DuckDB tools need to query the cache, the tree needs DuckDB's analytical SQL and native types, or the cache belongs beside large datasets or in a local/cloud workflow. Use Turso when its embedded Rust engine or Tantivy index fits the intended integration. Compare current measurements in [the store benchmark summary](../store-benchmarks.md) when Sense performance affects the decision.

If existing queries use FTS5 syntax, moving away from SQLite requires rewriting those queries. Read the selected engine's query guide under the `sense` skill before changing the config.
