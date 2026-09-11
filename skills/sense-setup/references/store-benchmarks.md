<!-- sense-store-benchmark release=0.24.5 -->
# Current store benchmark summary

The release assessment generated this file for store selection. Release `0.24.5` passed on 2026-09-11, measured on Apple M4 Pro with Node v26.7.0.

The timing rows ran on the same 6,566-note tree. They include CLI startup and each store's complete selected path. Ranked candidates and downstream work can differ by store, so these are current operating measurements rather than an isolated database-engine contest.

| Store | Cold index | Warm count | Lexical search | Semantic search | Portable semantic nDCG@10 |
|---|---|---|---|---|---|
| sqlite | 1,484 ms | 144 ms | 194 ms | 315 ms | 0.3306 |
| duckdb | 2,163 ms | 162 ms | 281 ms | 386 ms | 0.3284 |
| turso | 2,454 ms | 136 ms | 233 ms | 562 ms | 0.3307 |

Cold index is the first `status` that builds the cache. Warm count is a no-change `COUNT(*)` query. Lexical and semantic search are steady-state `sense search` commands. Lower timing is faster. Higher nDCG@10 is better; that quality column uses the same NFCorpus queries, judgments, result count, and model on every store.

Choose from the intended workflow, capabilities, and SQL compatibility. These numbers describe the current Sense implementations, not a permanent ranking of the engines. Treat small timing or relevance differences as diagnostic unless a representative workload for the target tree reproduces them.
