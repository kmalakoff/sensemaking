<!-- sense-store-benchmark release=0.26.0 -->
# Current store benchmark summary

The release assessment generated this file for store selection. Release `0.26.0` passed on 2026-10-01, measured on Apple M1 Pro with Node v26.10.0.

The timing rows ran on the same 6,566-note tree. They include CLI startup and each store's complete selected path. Ranked candidates and downstream work can differ by store, so these are current operating measurements rather than an isolated database-engine contest.

| Store | Cold index | Warm count | Lexical search | Semantic search | Portable semantic nDCG@10 |
|---|---|---|---|---|---|
| sqlite | 2,158 ms | 256 ms | 351 ms | 569 ms | 0.3306 |
| duckdb | 3,100 ms | 315 ms | 501 ms | 691 ms | 0.3282 |
| turso | 3,268 ms | 276 ms | 409 ms | 1,066 ms | 0.3299 |

Cold index measures core index creation and a count query, excluding document embeddings. Warm count is a no-change `COUNT(*)` query. Lexical and semantic search are steady-state `sense search` commands. Lower timing is faster. Higher nDCG@10 is better; that quality column uses the same NFCorpus queries, judgments, result count, and model on every store.

Choose from the intended workflow, capabilities, and SQL compatibility. These numbers describe the current Sense implementations, not a permanent ranking of the engines. Treat small timing or relevance differences as diagnostic unless a representative workload for the target tree reproduces them.
