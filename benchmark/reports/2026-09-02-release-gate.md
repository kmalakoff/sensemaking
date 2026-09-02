---
date: 2026-09-02
title: 2026-09-02 release gate
package_version: 0.20.0
release_version: null
chunk_version: chunk:v5
schema_version:
  sqlite: "19"
  duckdb: "3"
  turso: "4"
machine: Apple M4 Pro
node: v26.7.0
corpora:
  - /Users/kevin/Dev/OpenSource/ai/sensemaking/.tmp/cache/obsidian-hub-b11036f9
  - /Users/kevin/Dev/OpenSource/ai/sensemaking/.tmp/cache/obsidian-hub-x2-x2-hub-1
  - /Users/kevin/Dev/OpenSource/ai/sensemaking/.tmp/cache/obsidian-hub-x4-x4-hub-1
  - /Users/kevin/Dev/OpenSource/ai/sensemaking/.tmp/cache/stress-stress-1
  - nfcorpus
  - fever
embed_model: minishlab/potion-retrieval-32M
verdict: PASS
hub_cold_crawl_ms: 2086
hub_version_canary_ms: 26
hub_warm_query_ms: 131
hub_find_ms: 185
hub_find_row_tokens: 71
hub_inproc_cold_build_ms: 1838
hub_inproc_open_nochange_ms: 35.3
scale_13k_cold_crawl_ms: 3933
scale_13k_version_canary_ms: 28
scale_13k_warm_query_ms: 187
scale_13k_find_ms: 275
scale_13k_find_row_tokens: 71
scale_13k_inproc_cold_build_ms: 3481
scale_13k_inproc_open_nochange_ms: 71.2
scale_26k_cold_crawl_ms: 7018
scale_26k_version_canary_ms: 30
scale_26k_warm_query_ms: 293
scale_26k_find_ms: 443
scale_26k_find_row_tokens: 70
scale_26k_inproc_cold_build_ms: 5965
scale_26k_inproc_open_nochange_ms: 149.6
stress_cold_crawl_ms: 6085
stress_version_canary_ms: 28
stress_warm_query_ms: 93
stress_find_ms: 349
stress_find_row_tokens: 59
stress_inproc_cold_build_ms: 5579
stress_inproc_open_nochange_ms: 11.3
battery_duckdb_hub_cold_crawl_ms: 5926
battery_duckdb_hub_version_canary_ms: 27
battery_duckdb_hub_warm_query_ms: 162
battery_duckdb_hub_find_ms: 562
battery_duckdb_hub_find_row_tokens: 100
battery_duckdb_hub_inproc_cold_build_ms: 4390
battery_duckdb_hub_inproc_open_nochange_ms: 44.1
battery_duckdb_13k_cold_crawl_ms: 11867
battery_duckdb_13k_version_canary_ms: 26
battery_duckdb_13k_warm_query_ms: 219
battery_duckdb_13k_find_ms: 958
battery_duckdb_13k_find_row_tokens: 101
battery_duckdb_13k_inproc_cold_build_ms: 8853
battery_duckdb_13k_inproc_open_nochange_ms: 79.3
battery_duckdb_26k_cold_crawl_ms: 24461
battery_duckdb_26k_version_canary_ms: 27
battery_duckdb_26k_warm_query_ms: 329
battery_duckdb_26k_find_ms: 1753
battery_duckdb_26k_find_row_tokens: 100
battery_duckdb_26k_inproc_cold_build_ms: 17363
battery_duckdb_26k_inproc_open_nochange_ms: 156.5
battery_duckdb_stress_cold_crawl_ms: 47055
battery_duckdb_stress_version_canary_ms: 28
battery_duckdb_stress_warm_query_ms: 122
battery_duckdb_stress_find_ms: 1877
battery_duckdb_stress_find_row_tokens: 89
battery_duckdb_stress_inproc_cold_build_ms: 36756
battery_duckdb_stress_inproc_open_nochange_ms: 18.8
battery_turso_hub_cold_crawl_ms: 4424
battery_turso_hub_version_canary_ms: 27
battery_turso_hub_warm_query_ms: 139
battery_turso_hub_find_ms: 220
battery_turso_hub_find_row_tokens: 100
battery_turso_hub_inproc_cold_build_ms: 3466
battery_turso_hub_inproc_open_nochange_ms: 42.5
battery_turso_13k_cold_crawl_ms: 8415
battery_turso_13k_version_canary_ms: 25
battery_turso_13k_warm_query_ms: 197
battery_turso_13k_find_ms: 344
battery_turso_13k_find_row_tokens: 99
battery_turso_13k_inproc_cold_build_ms: 6240
battery_turso_13k_inproc_open_nochange_ms: 82.2
battery_turso_26k_cold_crawl_ms: 16669
battery_turso_26k_version_canary_ms: 28
battery_turso_26k_warm_query_ms: 314
battery_turso_26k_find_ms: 596
battery_turso_26k_find_row_tokens: 100
battery_turso_26k_inproc_cold_build_ms: 12308
battery_turso_26k_inproc_open_nochange_ms: 170
battery_turso_stress_cold_crawl_ms: 23158
battery_turso_stress_version_canary_ms: 27
battery_turso_stress_warm_query_ms: 98
battery_turso_stress_find_ms: 449
battery_turso_stress_find_row_tokens: 89
battery_turso_stress_inproc_cold_build_ms: 18425
battery_turso_stress_inproc_open_nochange_ms: 14.3
eval_nfcorpus_ndcg: 0.3427475423812081
eval_nfcorpus_hit: 0.7120743034055728
eval_fever_ndcg: 0.9336523047847716
eval_fever_hit: 0.9965227908383097
---

### 2026-09-02: release gate

`node benchmark/gate.mjs`, Apple M4 Pro, Node v26.7.0. Baseline: 0.20.0. Last tag: v0.20.0.

#### Verdict: PASS

No BLOCK reason.

A moved row localizes a cost; it does not identify its mechanism. Settling the mechanism means removing the suspected cause and re-measuring, or timing it directly -- never reading it off the delta.

#### Moved inside band, judged noise


#### Run summary

- provenance: last tag `v0.20.0`, package version 0.20.0, 93 changed path(s) read to decide what was owed (no commit hash: RELEASING.md's rule, since a rebase or squash can orphan one)
- owed: test-engines, store-dump, oracle, scale, fever, baseline, quality-baseline
- ran: 18 step(s) ok, 1 not owed, 2 owed-unmet

#### compare

| row | prior | current | verdict | reason |
|---|---|---|---|---|
| cold_crawl_ms | 1944 | 2086 | flat | — |
| version_canary_ms | 28 | 26 | flat | — |
| cold_embed_ms | 11725 | 11777 | flat | — |
| warm_query_ms | 131 | 131 | flat | — |
| bm25_search_ms | 134 | 134 | flat | — |
| find_ms | 180 | 185 | flat | — |
| find_row_tokens | 71 | 71 | flat | — |
| semantic_find_ms | 295 | 298 | flat | — |
| map_ms | 161 | 164 | flat | — |
| map_tokens | 496 | 496 | flat | — |
| peek_ms | 141 | 144 | flat | — |
| peek_tokens | 581 | 581 | flat | — |
| related_ms | 356 | 358 | flat | — |
| related_tokens | 183 | 183 | flat | — |
| largest_note_tokens | 77274 | 77274 | flat | — |
| bulk_change_ms | 585 | 558 | flat | — |
| bulk_watch_ms | 158 | 159 | flat | — |
| inproc.cold_build_ms | 1808 | 1838 | flat | — |
| inproc.open_nochange_ms | 35.2 | 35.3 | flat | — |
| inproc.update_1_file_ms | 37.5 | 38.4 | flat | — |
| inproc.update_10_files_ms | 43.1 | 41.7 | flat | — |

#### hub

| row | prior | current | verdict | reason |
|---|---|---|---|---|
| cold_crawl_ms | — | 2086 | no-prior | cold crawl (wall): no prior recorded |
| version_canary_ms | — | 26 | no-prior | `--version` canary: no prior recorded |
| cold_embed_ms | — | 11777 | no-prior | embed cold build (crawl + first vector-participating `search`, one process): no prior recorded |
| warm_query_ms | — | 131 | no-prior | warm query (`COUNT(*)`): no prior recorded |
| bm25_search_ms | — | 134 | no-prior | BM25 search (canonical join): no prior recorded |
| find_ms | — | 185 | no-prior | lexical `search` (BM25 + link fusion): no prior recorded |
| find_row_tokens | — | 71 | no-prior | `search` row size (json): no prior recorded |
| semantic_find_ms | — | 298 | no-prior | semantic `search` (steady state): no prior recorded |
| map_ms | — | 164 | no-prior | `map` (orient): no prior recorded |
| map_tokens | — | 496 | no-prior | `map` token count: no prior recorded |
| peek_ms | — | 144 | no-prior | `peek` largest note: no prior recorded |
| peek_tokens | — | 581 | no-prior | `peek` token count: no prior recorded |
| related_ms | — | 358 | no-prior | `related` (similar-but-unlinked): no prior recorded |
| related_tokens | — | 183 | no-prior | `related` token count: no prior recorded |
| largest_note_tokens | — | 77274 | no-prior | largest note (tokens): no prior recorded |
| bulk_change_ms | — | 558 | no-prior | bulk change: first query: no prior recorded |
| bulk_watch_ms | — | 159 | no-prior | bulk change: with warm watcher: no prior recorded |
| inproc.cold_build_ms | — | 1838 | no-prior | in-process: cold index build: no prior recorded |
| inproc.open_nochange_ms | — | 35.3 | no-prior | in-process: freshness check, no change: no prior recorded |
| inproc.update_1_file_ms | — | 38.4 | no-prior | in-process: update, 1 file touched: no prior recorded |
| inproc.update_10_files_ms | — | 41.7 | no-prior | in-process: update, 10 files modified: no prior recorded |

#### scale-13k

| row | prior | current | verdict | reason |
|---|---|---|---|---|
| cold_crawl_ms | — | 3933 | no-prior | cold crawl (wall): no prior recorded |
| version_canary_ms | — | 28 | no-prior | `--version` canary: no prior recorded |
| cold_embed_ms | — | 22612 | no-prior | embed cold build (crawl + first vector-participating `search`, one process): no prior recorded |
| warm_query_ms | — | 187 | no-prior | warm query (`COUNT(*)`): no prior recorded |
| bm25_search_ms | — | 193 | no-prior | BM25 search (canonical join): no prior recorded |
| find_ms | — | 275 | no-prior | lexical `search` (BM25 + link fusion): no prior recorded |
| find_row_tokens | — | 71 | no-prior | `search` row size (json): no prior recorded |
| semantic_find_ms | — | 477 | no-prior | semantic `search` (steady state): no prior recorded |
| map_ms | — | 249 | no-prior | `map` (orient): no prior recorded |
| map_tokens | — | 541 | no-prior | `map` token count: no prior recorded |
| peek_ms | — | 200 | no-prior | `peek` largest note: no prior recorded |
| peek_tokens | — | 692 | no-prior | `peek` token count: no prior recorded |
| related_ms | — | 648 | no-prior | `related` (similar-but-unlinked): no prior recorded |
| related_tokens | — | 164 | no-prior | `related` token count: no prior recorded |
| largest_note_tokens | — | 77274 | no-prior | largest note (tokens): no prior recorded |
| bulk_change_ms | — | 646 | no-prior | bulk change: first query: no prior recorded |
| bulk_watch_ms | — | 213 | no-prior | bulk change: with warm watcher: no prior recorded |
| inproc.cold_build_ms | — | 3481 | no-prior | in-process: cold index build: no prior recorded |
| inproc.open_nochange_ms | — | 71.2 | no-prior | in-process: freshness check, no change: no prior recorded |
| inproc.update_1_file_ms | — | 78.5 | no-prior | in-process: update, 1 file touched: no prior recorded |
| inproc.update_10_files_ms | — | 82.4 | no-prior | in-process: update, 10 files modified: no prior recorded |

#### scale-26k

| row | prior | current | verdict | reason |
|---|---|---|---|---|
| cold_crawl_ms | — | 7018 | no-prior | cold crawl (wall): no prior recorded |
| version_canary_ms | — | 30 | no-prior | `--version` canary: no prior recorded |
| cold_embed_ms | — | 45168 | no-prior | embed cold build (crawl + first vector-participating `search`, one process): no prior recorded |
| warm_query_ms | — | 293 | no-prior | warm query (`COUNT(*)`): no prior recorded |
| bm25_search_ms | — | 300 | no-prior | BM25 search (canonical join): no prior recorded |
| find_ms | — | 443 | no-prior | lexical `search` (BM25 + link fusion): no prior recorded |
| find_row_tokens | — | 70 | no-prior | `search` row size (json): no prior recorded |
| semantic_find_ms | — | 828 | no-prior | semantic `search` (steady state): no prior recorded |
| map_ms | — | 418 | no-prior | `map` (orient): no prior recorded |
| map_tokens | — | 541 | no-prior | `map` token count: no prior recorded |
| peek_ms | — | 316 | no-prior | `peek` largest note: no prior recorded |
| peek_tokens | — | 843 | no-prior | `peek` token count: no prior recorded |
| related_ms | — | 1207 | no-prior | `related` (similar-but-unlinked): no prior recorded |
| related_tokens | — | 162 | no-prior | `related` token count: no prior recorded |
| largest_note_tokens | — | 77274 | no-prior | largest note (tokens): no prior recorded |
| bulk_change_ms | — | 767 | no-prior | bulk change: first query: no prior recorded |
| bulk_watch_ms | — | 322 | no-prior | bulk change: with warm watcher: no prior recorded |
| inproc.cold_build_ms | — | 5965 | no-prior | in-process: cold index build: no prior recorded |
| inproc.open_nochange_ms | — | 149.6 | no-prior | in-process: freshness check, no change: no prior recorded |
| inproc.update_1_file_ms | — | 151.7 | no-prior | in-process: update, 1 file touched: no prior recorded |
| inproc.update_10_files_ms | — | 157.2 | no-prior | in-process: update, 10 files modified: no prior recorded |

#### stress

| row | prior | current | verdict | reason |
|---|---|---|---|---|
| cold_crawl_ms | — | 6085 | no-prior | cold crawl (wall): no prior recorded |
| version_canary_ms | — | 28 | no-prior | `--version` canary: no prior recorded |
| cold_embed_ms | — | 27945 | no-prior | embed cold build (crawl + first vector-participating `search`, one process): no prior recorded |
| warm_query_ms | — | 93 | no-prior | warm query (`COUNT(*)`): no prior recorded |
| bm25_search_ms | — | 8953 | no-prior | BM25 search (canonical join): no prior recorded |
| find_ms | — | 349 | no-prior | lexical `search` (BM25 + link fusion): no prior recorded |
| find_row_tokens | — | 59 | no-prior | `search` row size (json): no prior recorded |
| semantic_find_ms | — | 953 | no-prior | semantic `search` (steady state): no prior recorded |
| map_ms | — | 122 | no-prior | `map` (orient): no prior recorded |
| map_tokens | — | 398 | no-prior | `map` token count: no prior recorded |
| peek_ms | — | 110 | no-prior | `peek` largest note: no prior recorded |
| peek_tokens | — | 476 | no-prior | `peek` token count: no prior recorded |
| related_ms | — | 1530 | no-prior | `related` (similar-but-unlinked): no prior recorded |
| related_tokens | — | 60 | no-prior | `related` token count: no prior recorded |
| largest_note_tokens | — | 254821 | no-prior | largest note (tokens): no prior recorded |
| bulk_change_ms | — | 1820 | no-prior | bulk change: first query: no prior recorded |
| bulk_watch_ms | — | 121 | no-prior | bulk change: with warm watcher: no prior recorded |
| inproc.cold_build_ms | — | 5579 | no-prior | in-process: cold index build: no prior recorded |
| inproc.open_nochange_ms | — | 11.3 | no-prior | in-process: freshness check, no change: no prior recorded |
| inproc.update_1_file_ms | — | 24.6 | no-prior | in-process: update, 1 file touched: no prior recorded |
| inproc.update_10_files_ms | — | 89.1 | no-prior | in-process: update, 10 files modified: no prior recorded |

#### battery-duckdb-hub

| row | prior | current | verdict | reason |
|---|---|---|---|---|
| cold_crawl_ms | — | 5926 | no-prior | cold crawl (wall): no prior recorded |
| version_canary_ms | — | 27 | no-prior | `--version` canary: no prior recorded |
| cold_embed_ms | — | 31545 | no-prior | embed cold build (crawl + first vector-participating `search`, one process): no prior recorded |
| warm_query_ms | — | 162 | no-prior | warm query (`COUNT(*)`): no prior recorded |
| find_ms | — | 562 | no-prior | lexical `search` (BM25 + link fusion): no prior recorded |
| find_row_tokens | — | 100 | no-prior | `search` row size (json): no prior recorded |
| semantic_find_ms | — | 666 | no-prior | semantic `search` (steady state): no prior recorded |
| map_ms | — | 216 | no-prior | `map` (orient): no prior recorded |
| map_tokens | — | 563 | no-prior | `map` token count: no prior recorded |
| peek_ms | — | 183 | no-prior | `peek` largest note: no prior recorded |
| peek_tokens | — | 581 | no-prior | `peek` token count: no prior recorded |
| related_ms | — | 493 | no-prior | `related` (similar-but-unlinked): no prior recorded |
| related_tokens | — | 183 | no-prior | `related` token count: no prior recorded |
| largest_note_tokens | — | 77274 | no-prior | largest note (tokens): no prior recorded |
| bulk_change_ms | — | 1225 | no-prior | bulk change: first query: no prior recorded |
| bulk_watch_ms | — | 1207 | no-prior | bulk change: with warm watcher: no prior recorded |
| inproc.cold_build_ms | — | 4390 | no-prior | in-process: cold index build: no prior recorded |
| inproc.open_nochange_ms | — | 44.1 | no-prior | in-process: freshness check, no change: no prior recorded |
| inproc.update_1_file_ms | — | 56.6 | no-prior | in-process: update, 1 file touched: no prior recorded |
| inproc.update_10_files_ms | — | 75.2 | no-prior | in-process: update, 10 files modified: no prior recorded |

#### battery-duckdb-13k

| row | prior | current | verdict | reason |
|---|---|---|---|---|
| cold_crawl_ms | — | 11867 | no-prior | cold crawl (wall): no prior recorded |
| version_canary_ms | — | 26 | no-prior | `--version` canary: no prior recorded |
| cold_embed_ms | — | 55689 | no-prior | embed cold build (crawl + first vector-participating `search`, one process): no prior recorded |
| warm_query_ms | — | 219 | no-prior | warm query (`COUNT(*)`): no prior recorded |
| find_ms | — | 958 | no-prior | lexical `search` (BM25 + link fusion): no prior recorded |
| find_row_tokens | — | 101 | no-prior | `search` row size (json): no prior recorded |
| semantic_find_ms | — | 1172 | no-prior | semantic `search` (steady state): no prior recorded |
| map_ms | — | 365 | no-prior | `map` (orient): no prior recorded |
| map_tokens | — | 573 | no-prior | `map` token count: no prior recorded |
| peek_ms | — | 253 | no-prior | `peek` largest note: no prior recorded |
| peek_tokens | — | 692 | no-prior | `peek` token count: no prior recorded |
| related_ms | — | 867 | no-prior | `related` (similar-but-unlinked): no prior recorded |
| related_tokens | — | 164 | no-prior | `related` token count: no prior recorded |
| largest_note_tokens | — | 77274 | no-prior | largest note (tokens): no prior recorded |
| bulk_change_ms | — | 1172 | no-prior | bulk change: first query: no prior recorded |
| bulk_watch_ms | — | 1206 | no-prior | bulk change: with warm watcher: no prior recorded |
| inproc.cold_build_ms | — | 8853 | no-prior | in-process: cold index build: no prior recorded |
| inproc.open_nochange_ms | — | 79.3 | no-prior | in-process: freshness check, no change: no prior recorded |
| inproc.update_1_file_ms | — | 99.8 | no-prior | in-process: update, 1 file touched: no prior recorded |
| inproc.update_10_files_ms | — | 113.6 | no-prior | in-process: update, 10 files modified: no prior recorded |

#### battery-duckdb-26k

| row | prior | current | verdict | reason |
|---|---|---|---|---|
| cold_crawl_ms | — | 24461 | no-prior | cold crawl (wall): no prior recorded |
| version_canary_ms | — | 27 | no-prior | `--version` canary: no prior recorded |
| cold_embed_ms | — | 107490 | no-prior | embed cold build (crawl + first vector-participating `search`, one process): no prior recorded |
| warm_query_ms | — | 329 | no-prior | warm query (`COUNT(*)`): no prior recorded |
| find_ms | — | 1753 | no-prior | lexical `search` (BM25 + link fusion): no prior recorded |
| find_row_tokens | — | 100 | no-prior | `search` row size (json): no prior recorded |
| semantic_find_ms | — | 2022 | no-prior | semantic `search` (steady state): no prior recorded |
| map_ms | — | 546 | no-prior | `map` (orient): no prior recorded |
| map_tokens | — | 573 | no-prior | `map` token count: no prior recorded |
| peek_ms | — | 385 | no-prior | `peek` largest note: no prior recorded |
| peek_tokens | — | 843 | no-prior | `peek` token count: no prior recorded |
| related_ms | — | 1111 | no-prior | `related` (similar-but-unlinked): no prior recorded |
| related_tokens | — | 162 | no-prior | `related` token count: no prior recorded |
| largest_note_tokens | — | 77274 | no-prior | largest note (tokens): no prior recorded |
| bulk_change_ms | — | 1409 | no-prior | bulk change: first query: no prior recorded |
| bulk_watch_ms | — | 1396 | no-prior | bulk change: with warm watcher: no prior recorded |
| inproc.cold_build_ms | — | 17363 | no-prior | in-process: cold index build: no prior recorded |
| inproc.open_nochange_ms | — | 156.5 | no-prior | in-process: freshness check, no change: no prior recorded |
| inproc.update_1_file_ms | — | 184 | no-prior | in-process: update, 1 file touched: no prior recorded |
| inproc.update_10_files_ms | — | 200.1 | no-prior | in-process: update, 10 files modified: no prior recorded |

#### battery-duckdb-stress

| row | prior | current | verdict | reason |
|---|---|---|---|---|
| cold_crawl_ms | — | 47055 | no-prior | cold crawl (wall): no prior recorded |
| version_canary_ms | — | 28 | no-prior | `--version` canary: no prior recorded |
| cold_embed_ms | — | 132173 | no-prior | embed cold build (crawl + first vector-participating `search`, one process): no prior recorded |
| warm_query_ms | — | 122 | no-prior | warm query (`COUNT(*)`): no prior recorded |
| find_ms | — | 1877 | no-prior | lexical `search` (BM25 + link fusion): no prior recorded |
| find_row_tokens | — | 89 | no-prior | `search` row size (json): no prior recorded |
| semantic_find_ms | — | 1993 | no-prior | semantic `search` (steady state): no prior recorded |
| map_ms | — | 312 | no-prior | `map` (orient): no prior recorded |
| map_tokens | — | 435 | no-prior | `map` token count: no prior recorded |
| peek_ms | — | 177 | no-prior | `peek` largest note: no prior recorded |
| peek_tokens | — | 476 | no-prior | `peek` token count: no prior recorded |
| related_ms | — | 712 | no-prior | `related` (similar-but-unlinked): no prior recorded |
| related_tokens | — | 60 | no-prior | `related` token count: no prior recorded |
| largest_note_tokens | — | 254821 | no-prior | largest note (tokens): no prior recorded |
| bulk_change_ms | — | 11752 | no-prior | bulk change: first query: no prior recorded |
| bulk_watch_ms | — | 11559 | no-prior | bulk change: with warm watcher: no prior recorded |
| inproc.cold_build_ms | — | 36756 | no-prior | in-process: cold index build: no prior recorded |
| inproc.open_nochange_ms | — | 18.8 | no-prior | in-process: freshness check, no change: no prior recorded |
| inproc.update_1_file_ms | — | 270 | no-prior | in-process: update, 1 file touched: no prior recorded |
| inproc.update_10_files_ms | — | 450.9 | no-prior | in-process: update, 10 files modified: no prior recorded |

#### battery-turso-hub

| row | prior | current | verdict | reason |
|---|---|---|---|---|
| cold_crawl_ms | — | 4424 | no-prior | cold crawl (wall): no prior recorded |
| version_canary_ms | — | 27 | no-prior | `--version` canary: no prior recorded |
| cold_embed_ms | — | 16651 | no-prior | embed cold build (crawl + first vector-participating `search`, one process): no prior recorded |
| warm_query_ms | — | 139 | no-prior | warm query (`COUNT(*)`): no prior recorded |
| find_ms | — | 220 | no-prior | lexical `search` (BM25 + link fusion): no prior recorded |
| find_row_tokens | — | 100 | no-prior | `search` row size (json): no prior recorded |
| semantic_find_ms | — | 507 | no-prior | semantic `search` (steady state): no prior recorded |
| map_ms | — | 302 | no-prior | `map` (orient): no prior recorded |
| map_tokens | — | 535 | no-prior | `map` token count: no prior recorded |
| peek_ms | — | 159 | no-prior | `peek` largest note: no prior recorded |
| peek_tokens | — | 581 | no-prior | `peek` token count: no prior recorded |
| related_ms | — | 633 | no-prior | `related` (similar-but-unlinked): no prior recorded |
| related_tokens | — | 183 | no-prior | `related` token count: no prior recorded |
| largest_note_tokens | — | 77274 | no-prior | largest note (tokens): no prior recorded |
| bulk_change_ms | — | 836 | no-prior | bulk change: first query: no prior recorded |
| bulk_watch_ms | — | 891 | no-prior | bulk change: with warm watcher: no prior recorded |
| inproc.cold_build_ms | — | 3466 | no-prior | in-process: cold index build: no prior recorded |
| inproc.open_nochange_ms | — | 42.5 | no-prior | in-process: freshness check, no change: no prior recorded |
| inproc.update_1_file_ms | — | 54.7 | no-prior | in-process: update, 1 file touched: no prior recorded |
| inproc.update_10_files_ms | — | 121.8 | no-prior | in-process: update, 10 files modified: no prior recorded |

#### battery-turso-13k

| row | prior | current | verdict | reason |
|---|---|---|---|---|
| cold_crawl_ms | — | 8415 | no-prior | cold crawl (wall): no prior recorded |
| version_canary_ms | — | 25 | no-prior | `--version` canary: no prior recorded |
| cold_embed_ms | — | 33118 | no-prior | embed cold build (crawl + first vector-participating `search`, one process): no prior recorded |
| warm_query_ms | — | 197 | no-prior | warm query (`COUNT(*)`): no prior recorded |
| find_ms | — | 344 | no-prior | lexical `search` (BM25 + link fusion): no prior recorded |
| find_row_tokens | — | 99 | no-prior | `search` row size (json): no prior recorded |
| semantic_find_ms | — | 869 | no-prior | semantic `search` (steady state): no prior recorded |
| map_ms | — | 525 | no-prior | `map` (orient): no prior recorded |
| map_tokens | — | 541 | no-prior | `map` token count: no prior recorded |
| peek_ms | — | 227 | no-prior | `peek` largest note: no prior recorded |
| peek_tokens | — | 692 | no-prior | `peek` token count: no prior recorded |
| related_ms | — | 1243 | no-prior | `related` (similar-but-unlinked): no prior recorded |
| related_tokens | — | 164 | no-prior | `related` token count: no prior recorded |
| largest_note_tokens | — | 77274 | no-prior | largest note (tokens): no prior recorded |
| bulk_change_ms | — | 1032 | no-prior | bulk change: first query: no prior recorded |
| bulk_watch_ms | — | 1026 | no-prior | bulk change: with warm watcher: no prior recorded |
| inproc.cold_build_ms | — | 6240 | no-prior | in-process: cold index build: no prior recorded |
| inproc.open_nochange_ms | — | 82.2 | no-prior | in-process: freshness check, no change: no prior recorded |
| inproc.update_1_file_ms | — | 105.9 | no-prior | in-process: update, 1 file touched: no prior recorded |
| inproc.update_10_files_ms | — | 236.2 | no-prior | in-process: update, 10 files modified: no prior recorded |

#### battery-turso-26k

| row | prior | current | verdict | reason |
|---|---|---|---|---|
| cold_crawl_ms | — | 16669 | no-prior | cold crawl (wall): no prior recorded |
| version_canary_ms | — | 28 | no-prior | `--version` canary: no prior recorded |
| cold_embed_ms | — | 65864 | no-prior | embed cold build (crawl + first vector-participating `search`, one process): no prior recorded |
| warm_query_ms | — | 314 | no-prior | warm query (`COUNT(*)`): no prior recorded |
| find_ms | — | 596 | no-prior | lexical `search` (BM25 + link fusion): no prior recorded |
| find_row_tokens | — | 100 | no-prior | `search` row size (json): no prior recorded |
| semantic_find_ms | — | 1668 | no-prior | semantic `search` (steady state): no prior recorded |
| map_ms | — | 987 | no-prior | `map` (orient): no prior recorded |
| map_tokens | — | 541 | no-prior | `map` token count: no prior recorded |
| peek_ms | — | 371 | no-prior | `peek` largest note: no prior recorded |
| peek_tokens | — | 843 | no-prior | `peek` token count: no prior recorded |
| related_ms | — | 2470 | no-prior | `related` (similar-but-unlinked): no prior recorded |
| related_tokens | — | 162 | no-prior | `related` token count: no prior recorded |
| largest_note_tokens | — | 77274 | no-prior | largest note (tokens): no prior recorded |
| bulk_change_ms | — | 1371 | no-prior | bulk change: first query: no prior recorded |
| bulk_watch_ms | — | 1415 | no-prior | bulk change: with warm watcher: no prior recorded |
| inproc.cold_build_ms | — | 12308 | no-prior | in-process: cold index build: no prior recorded |
| inproc.open_nochange_ms | — | 170 | no-prior | in-process: freshness check, no change: no prior recorded |
| inproc.update_1_file_ms | — | 222.9 | no-prior | in-process: update, 1 file touched: no prior recorded |
| inproc.update_10_files_ms | — | 644.6 | no-prior | in-process: update, 10 files modified: no prior recorded |

#### battery-turso-stress

| row | prior | current | verdict | reason |
|---|---|---|---|---|
| cold_crawl_ms | — | 23158 | no-prior | cold crawl (wall): no prior recorded |
| version_canary_ms | — | 27 | no-prior | `--version` canary: no prior recorded |
| cold_embed_ms | — | 63484 | no-prior | embed cold build (crawl + first vector-participating `search`, one process): no prior recorded |
| warm_query_ms | — | 98 | no-prior | warm query (`COUNT(*)`): no prior recorded |
| find_ms | — | 449 | no-prior | lexical `search` (BM25 + link fusion): no prior recorded |
| find_row_tokens | — | 89 | no-prior | `search` row size (json): no prior recorded |
| semantic_find_ms | — | 2104 | no-prior | semantic `search` (steady state): no prior recorded |
| map_ms | — | 411 | no-prior | `map` (orient): no prior recorded |
| map_tokens | — | 398 | no-prior | `map` token count: no prior recorded |
| peek_ms | — | 114 | no-prior | `peek` largest note: no prior recorded |
| peek_tokens | — | 476 | no-prior | `peek` token count: no prior recorded |
| related_ms | — | 3526 | no-prior | `related` (similar-but-unlinked): no prior recorded |
| related_tokens | — | 60 | no-prior | `related` token count: no prior recorded |
| largest_note_tokens | — | 254821 | no-prior | largest note (tokens): no prior recorded |
| bulk_change_ms | — | 5500 | no-prior | bulk change: first query: no prior recorded |
| bulk_watch_ms | — | 5585 | no-prior | bulk change: with warm watcher: no prior recorded |
| inproc.cold_build_ms | — | 18425 | no-prior | in-process: cold index build: no prior recorded |
| inproc.open_nochange_ms | — | 14.3 | no-prior | in-process: freshness check, no change: no prior recorded |
| inproc.update_1_file_ms | — | 49 | no-prior | in-process: update, 1 file touched: no prior recorded |
| inproc.update_10_files_ms | — | 302 | no-prior | in-process: update, 10 files modified: no prior recorded |

#### eval-nfcorpus/bm25-only

| row | prior | current | verdict | reason |
|---|---|---|---|---|
| ndcg | — | 0.32339782487130336 | no-prior | nDCG@10: no prior recorded |
| rr | — | 0.5183153963339723 | no-prior | MRR@10: no prior recorded |
| hit | — | 0.6873065015479877 | no-prior | hit@10: no prior recorded |

#### eval-nfcorpus/fused

| row | prior | current | verdict | reason |
|---|---|---|---|---|
| ndcg | — | 0.32339782487130336 | no-prior | nDCG@10: no prior recorded |
| rr | — | 0.5183153963339723 | no-prior | MRR@10: no prior recorded |
| hit | — | 0.6873065015479877 | no-prior | hit@10: no prior recorded |

#### eval-nfcorpus/semantic

| row | prior | current | verdict | reason |
|---|---|---|---|---|
| ndcg | — | 0.3427475423812081 | no-prior | nDCG@10: no prior recorded |
| rr | — | 0.5555014988451521 | no-prior | MRR@10: no prior recorded |
| hit | — | 0.7120743034055728 | no-prior | hit@10: no prior recorded |

#### eval-fever/bm25-only

| row | prior | current | verdict | reason |
|---|---|---|---|---|
| ndcg | — | 0.9435278650592086 | no-prior | nDCG@10: no prior recorded |
| rr | — | 0.9507565449643487 | no-prior | MRR@10: no prior recorded |
| hit | — | 0.9969007483558848 | no-prior | hit@10: no prior recorded |

#### eval-fever/fused

| row | prior | current | verdict | reason |
|---|---|---|---|---|
| ndcg | — | 0.936062899468175 | no-prior | nDCG@10: no prior recorded |
| rr | — | 0.9381366934356592 | no-prior | MRR@10: no prior recorded |
| hit | — | 0.9971275228664298 | no-prior | hit@10: no prior recorded |

#### eval-fever/semantic

| row | prior | current | verdict | reason |
|---|---|---|---|---|
| ndcg | — | 0.9336523047847716 | no-prior | nDCG@10: no prior recorded |
| rr | — | 0.9343124532802529 | no-prior | MRR@10: no prior recorded |
| hit | — | 0.9965227908383097 | no-prior | hit@10: no prior recorded |

