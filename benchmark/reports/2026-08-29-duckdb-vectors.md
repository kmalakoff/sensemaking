---
date: 2026-08-29
title: DuckDB vector search (D2) vs sqlite
package_version: 0.17.1
schema_version: 18
machine: Apple Silicon
node: '26.7.0'
duckdb_version: 1.5.5
embed_model: minishlab/potion-retrieval-32M
store_dims: 256
corpora:
  - synthetic-200
  - synthetic-1000
  - synthetic-3000
sqlite_candidates_ms_3000: 7.0
duckdb_candidates_ms_3000: 2.8
sqlite_similar_ms_3000: 9.4
duckdb_similar_ms_3000: 5.2
tests_passing: 933
---

# DuckDB vector search (D2) vs sqlite

DuckDB wins on the vector path, and wins by scaling rather than by a constant.
This is the measurement the store's justification rests on.

## Isolated vector scan

`vectors.candidates()` and `vectors.similar()` timed directly with a
precomputed query vector, on an already-embedded tree with nothing pending, so
no lexical, reconcile or fusion work is charged to either store. Medians.

| files | sqlite candidates | duckdb candidates | sqlite similar | duckdb similar |
|---|---|---|---|---|
| 200 | 0.5 ms | 1.0 ms | 0.7 ms | 1.5 ms |
| 1000 | 2.0 ms | 1.5 ms | 2.1 ms | 2.9 ms |
| 3000 | 7.0 ms | 2.8 ms | 9.4 ms | 5.2 ms |

Growth 200 -> 3000 is the finding: sqlite's JS loop grows 14x on candidates
(0.5 -> 7.0) and 13x on similar (0.7 -> 9.4); DuckDB's native scan grows 2.8x
(1.0 -> 2.8) and 3.5x (1.5 -> 5.2). sqlite pulls every stored int8 vector
across the driver and scores it in JS; DuckDB evaluates
`array_cosine_similarity` over `FLOAT[256]` columns and applies
`ORDER BY ... LIMIT k` inside the engine, so only k rows cross the boundary.

Crossover is around 1,000 files for `candidates` and between 1,000 and 3,000
for `similar`. Below that, DuckDB's fixed per-process cost (~30 ms addon load,
amortized here across repeated calls) and its per-call overhead dominate a scan
that is trivially small for either engine.

## Why the first attempt said the opposite

An earlier run timed `search()` end to end and showed DuckDB 3-6x SLOWER
(133 ms vs 432 ms at 500 files; 165 ms vs 1077 ms at 2000). That measurement
was wrong for this question: `search()` fuses words + links + vectors, so it
charged DuckDB's lexical path -- 16 ms steady state, 228 ms after any reconcile
because the BM25 index rebuilds wholesale (see the D1 report) -- to the vector
column. Isolating the scan reverses the verdict. Recorded because the mistake
is easy to repeat: a fused number cannot answer a per-signal question.

## Verdict

DuckDB wins the vector path above roughly 1,000 files, by an increasing margin,
which is the premise the store was adopted on. It loses the lexical path at
every size (D1 report). Both hold simultaneously, and a tree chooses its store
on which signal it leans on.
