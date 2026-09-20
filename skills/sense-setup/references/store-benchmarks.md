<!-- sense-store-benchmark release=0.25.0 -->
# Current store benchmark summary

The release assessment generated this file for store selection. Release `0.25.0` passed on 2026-09-20, measured on Apple M4 Pro with Node v26.8.2.

The timing rows ran on the same 6,566-note tree. They include CLI startup and each store's complete selected path. Ranked candidates and downstream work can differ by store, so these are current operating measurements rather than an isolated database-engine contest.

| Store | Cold index | Warm count | Lexical search | Semantic search | Portable semantic nDCG@10 |
|---|---|---|---|---|---|
| sqlite | 1,197 ms | 126 ms | 190 ms | 338 ms | 0.3306 |
| duckdb | 1,801 ms | 164 ms | 297 ms | 415 ms | 0.3284 |
| turso | 2,056 ms | 135 ms | 232 ms | 640 ms | 0.3307 |

Cold index measures core index creation and a count query, excluding document embeddings. Warm count is a no-change `COUNT(*)` query. Lexical and semantic search are steady-state `sense search` commands. Lower timing is faster. Higher nDCG@10 is better; that quality column uses the same NFCorpus queries, judgments, result count, and model on every store.

Choose from the intended workflow, capabilities, and SQL compatibility. These numbers describe the current Sense implementations, not a permanent ranking of the engines. Treat small timing or relevance differences as diagnostic unless a representative workload for the target tree reproduces them.
