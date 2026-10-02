<!-- sense-store-benchmark release=0.27.0 -->
# Current store benchmark summary

The release assessment generated this file for store selection. Release `0.27.0` passed on 2026-10-03, measured on Apple M1 Pro with Node v26.10.0.

The timing rows ran on the same 6,566-note tree. They include CLI startup and each store's complete selected path. Ranked candidates and downstream work can differ by store, so these are current operating measurements rather than an isolated database-engine contest.

| Store | Cold index | Warm count | Lexical search | Semantic search | Portable semantic nDCG@10 |
|---|---|---|---|---|---|
| sqlite | 2,254 ms | 260 ms | 350 ms | 576 ms | 0.3306 |
| duckdb | 3,026 ms | 319 ms | 510 ms | 695 ms | 0.3282 |
| turso | 3,273 ms | 279 ms | 412 ms | 1,081 ms | 0.3299 |

Cold index measures core index creation and a count query, excluding document embeddings. Warm count is a no-change `COUNT(*)` query. Lexical and semantic search are steady-state `sense search` commands. Lower timing is faster. Higher nDCG@10 is better; that quality column uses the same NFCorpus queries, judgments, result count, and model on every store.

Choose from the intended workflow, capabilities, and SQL compatibility. These numbers describe the current Sense implementations, not a permanent ranking of the engines. Treat small timing or relevance differences as diagnostic unless a representative workload for the target tree reproduces them.
