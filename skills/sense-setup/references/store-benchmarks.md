<!-- sense-store-benchmark release=0.24.6 -->
# Current store benchmark summary

The release assessment generated this file for store selection. Release `0.24.6` passed on 2026-09-16, measured on Apple M4 Pro with Node v26.7.0.

The timing rows ran on the same 6,566-note tree. They include CLI startup and each store's complete selected path. Ranked candidates and downstream work can differ by store, so these are current operating measurements rather than an isolated database-engine contest.

| Store | Cold index | Warm count | Lexical search | Semantic search | Portable semantic nDCG@10 |
|---|---|---|---|---|---|
| sqlite | 1,471 ms | 143 ms | 192 ms | 318 ms | 0.3306 |
| duckdb | 2,149 ms | 162 ms | 279 ms | 399 ms | 0.3284 |
| turso | 2,727 ms | 138 ms | 237 ms | 584 ms | 0.3307 |

Cold index is the first `status` that builds the cache. Warm count is a no-change `COUNT(*)` query. Lexical and semantic search are steady-state `sense search` commands. Lower timing is faster. Higher nDCG@10 is better; that quality column uses the same NFCorpus queries, judgments, result count, and model on every store.

Choose from the intended workflow, capabilities, and SQL compatibility. These numbers describe the current Sense implementations, not a permanent ranking of the engines. Treat small timing or relevance differences as diagnostic unless a representative workload for the target tree reproduces them.
