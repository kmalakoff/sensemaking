---
date: 2026-08-29
title: DuckDB lexical search (D1) vs sqlite
package_version: 0.17.1
schema_version: 18
machine: Apple Silicon
node: '26.7.0'
corpora:
  - synthetic-50
  - synthetic-200
  - synthetic-500
duckdb_version: 1.5.5
sqlite_query_after_reconcile_ms_500: 2.5
duckdb_query_after_reconcile_ms_500: 227.8
sqlite_warm_query_ms_500: 2.0
duckdb_warm_query_ms_500: 16.1
tests_passing: 920
---

# DuckDB lexical search (D1) vs sqlite

Synthetic trees, `words` signal only, both stores over the same fixtures.

| store | files | cold open+reconcile | first query | warm query | query after a 1-file reconcile |
|---|---|---|---|---|---|
| sqlite | 50 | 93.2 ms | 1.3 ms | 1.2 ms | 1.1 ms |
| duckdb | 50 | 143.1 ms | 45.1 ms | 13.9 ms | 40.6 ms |
| sqlite | 200 | 296.9 ms | 1.9 ms | 1.8 ms | 1.7 ms |
| duckdb | 200 | 291.8 ms | 111.0 ms | 15.2 ms | 103.9 ms |
| sqlite | 500 | 683.4 ms | 2.5 ms | 2.0 ms | 2.5 ms |
| duckdb | 500 | 663.3 ms | 236.6 ms | 16.1 ms | 227.8 ms |

Two distinct costs, worth separating because only one is ours to fix.

**Rebuild per reconcile (upstream).** DuckDB's query after one file changes
(227.8 ms at 500 files) is indistinguishable from its cold-build query
(236.6 ms), because any content change rebuilds the whole BM25 index --
duckdb-fts has no incremental maintenance. sqlite pays ~2.5 ms at every size.
This grows with tree size and is the gate W1 tracks; nothing local fixes it.

**Steady-state query (ours).** Even with the index current, 16.1 ms vs 2.0 ms.
`match_bm25` takes no field weights, so each query issues four subqueries (one
per weighted field plus the conjunctive gate) and combines 10/5/1 in SQL.
Collapsing those into one pass is a real local optimization, unmeasured.

Cold open+reconcile is at parity from 200 files up; the 50-file row carries
DuckDB's ~30 ms fixed per-process cost (native addon load), which amortizes.

## Optimization candidates (unmeasured)

1. Collapse the four `match_bm25` subqueries into a single scan. Target: the
   16 ms steady-state row. Bounded by BM25's own cost, so the ceiling is
   sqlite's ~2 ms, not better.
2. Rebuild the BM25 index over only changed paths if duckdb-fts ever exposes a
   partial rebuild; today `PRAGMA create_fts_index` is all-or-nothing.
3. Skip the BM25 index entirely for `contains()`-only queries (exact substring,
   unspaced scripts), which never consult it. Would make substring search on a
   freshly-edited tree cheap while ranked search still pays the rebuild.
