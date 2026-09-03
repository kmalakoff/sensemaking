---
date: 2026-08-23
title: obsidian-hub release-gate battery (0.13.2)
package_version: 0.13.2
machine: Apple Silicon
node: '26.7.0'
corpora:
  - obsidian-hub@b11036f9
  - obsidian-hub-x2
  - obsidian-hub-x4
  - stress
  - nfcorpus
  - fever
nfcorpus_ndcg10_semantic: 0.3431
nfcorpus_hit10_semantic: 0.7121
fever_ndcg10_semantic: 0.9343
fever_hit10_semantic: 0.9967
hub_cold_crawl_local_ms: 1506
stress_semantic_search_ms: 971
superseded_by: 2026-08-29-0.18.0-release-gate.md
---

## Results: obsidian-hub @ b11036f9 (6,566 notes, 14 MB)

Apple Silicon, Node 26.7.0. 2026-08-23. `local` is the working tree about to be released; the baseline column is whatever `package.json` names, so a bare `compare.mjs` always reads "last release vs what ships next". This table was measured against 0.12.3 (the release before the tags/embed/_ctime schema change) to price the feature set; the intervening 0.13.0/0.13.1 shipped unbenchmarked.

| metric | 0.12.3 | local |
|---|---|---|
| cold crawl | 1171 ms | 1506 ms |
| warm query (`COUNT(*)`) | 95 ms | 96 ms |
| BM25 search (canonical join) | 102 ms | 104 ms |
| lexical `search` (BM25 + link fusion) | 145 ms | 154 ms |
| `search` row size (json) | ~71 tokens | ~71 tokens |
| `map` (orient) | 120 ms / ~486 tokens | 121 ms / ~487 tokens |
| `peek` largest note (~77274 t) | 100 ms / ~581 tokens (0.8%) | 101 ms / ~581 tokens (0.8%) |
| bulk change (500 files): first query | 254 ms | 281 ms |
| bulk change (500 files): with warm watcher | 115 ms | 128 ms |
| in-process: cold index build | 1022 ms | 1292 ms |
| in-process: freshness check, no change | 35.6 ms | 39.1 ms |
| in-process: update, 1 file touched | 36.7 ms | 37.7 ms |
| in-process: update, 10 files modified | 37.8 ms | 38.5 ms |

**Cold build +26%, priced and accepted.** The tags feature scans every body line for inline
`#tags` at parse time (isolated by toggling the feature: ~295 ms of the ~330 ms delta on this
tree; `_ctime` and the embed grain are the rest). It is paid once per tree and buys the
`tags` table. Warm paths -- freshness, updates, queries, token contracts -- are flat.

**0.16.0 (link parity): flat-to-faster, quality unmoved.** Region masking (fences, HTML
comments, inline code) in link extraction, frontmatter wikilinks, markdown linkpath
semantics, and the self/shortest-path tiebreaks left every row within noise vs 0.15.0
(in-process cold build 1497 -> 1376 ms; freshness flat; peek flat), and FEVER hit@10 is
digit-identical (0.9969/0.9971/0.9967) despite the hub's resolved graph shrinking from
37,928 to 21,830 edges -- the removed 16k were commented-out template scaffolding, and their
absence changes no eval answer. Correctness gate: zero diff vs Obsidian's metadataCache on
tags, resolved links, and unresolved links across both corpora (6,566 + 1,305 files),
via `benchmark/oracle.mjs`.

**0.15.0 (fence semantics + oracle validation): flat.** The shared run-length fence tracker,
HTML-block state, and link-destination masking left every row within noise (in-process cold
build 1341 -> 1345 ms vs 0.14.0; warm paths identical; nfcorpus digit-identical). Correctness
gate for that release was external: zero tag-table diff vs Obsidian's own metadataCache on
6,567 hub + 1,302 vault files, and 22/29 CommonMark fence spec examples (7 divergences
asserted in test/unit/features/fences.test.ts).

**What this table caught before 0.13.2 shipped.** The first post-0.13.0 run showed lexical
`search` at +25-65 ms per query: the `DISTINCT` added to linkEdges() during review sorted the
whole links table on every search, and worse, silently changed edge semantics -- two written
targets resolving to one dst had always been two edges, a weight the FEVER gate was measured
on. Rewritten as UNION ALL with a NOT EXISTS probe that excludes only an embed's exact link
twin: search back to 145 -> 154 ms, and both eval tables reproduce their documented figures
(nfcorpus digit-for-digit; fever hit@10 0.9969/0.9971/0.9967).

**A harness caveat found two releases back, still load-bearing.** The first version
`compare.mjs` benchmarks pays a large one-time machine warmup (the baseline's `npm install`
is itself the warmup); a reversed-column-order run is the confirmation that a delta is real.
Cold-crawl wall numbers move with file-cache state, documented under Scale below: only the
version A/B on the same tree in the same sitting is comparable.

## Scale

The README claims linear scaling and links here rather than carrying figures of its own, so this is the measurement behind it. `obsidian-hub-x2` and `obsidian-hub-x4` (13k / 26k notes) are named corpora that replicate the pinned hub tree N times under one root: real notes, real frontmatter, real links, regenerated from nothing like every corpus. Duplicate basenames across copies stress link-ambiguity resolution harder than a natural tree. Run `node benchmark/run.mjs . <corpusPath>` per tree; regenerate scale rows together with the main table.

Measured 2026-08-22, same machine and sitting as the table above (the `local` column). The
lexical and semantic rows come from two presets over the same glob, differing only in
`semantic`, so both measure the same files with and without vector participation:

| metric | 6.5k (hub) | 13k (x2) | 26k (x4) |
|---|---|---|---|
| cold crawl (wall) | 1.19 s | 3.64 s | 7.27 s |
| warm query | 96 ms | 154 ms | 273 ms |
| lexical `search` | 150 ms | 263 ms | 450 ms |
| semantic `search` (steady state) | — | 402 ms | 754 ms |
| `map` | 123 ms / ~486 t | 213 ms / ~531 t | 392 ms / ~531 t |
| `peek` | 104 ms / ~581 t | 167 ms / ~692 t | 288 ms / ~843 t |
| `related` | — | 346 ms / ~182 t | 596 ms / ~162 t |
| bulk change (500 files): first query | 282 ms | 351 ms | 519 ms |
| in-process: freshness check, no change | 37.3 ms | 73.5 ms | 153.2 ms |
| in-process: update, 1 file touched | 39.4 ms | 73.2 ms | 156.7 ms |

Every row is linear or better in note count across a 4x range. The freshness check (the cost
every single invocation pays) is 153 ms at 26k notes, and updates track it. `map` token
counts stay flat with tree size at 13k and 26k (~531 t both); the hub column moved for an
unrelated reason -- it is a checkout-shaped tree and trips the new recency caveat (see Results
above) -- not because output grew with size, so the claim still holds as "flat with size,"
just no longer "flat across every tree regardless of shape." Semantic `search` is linear in
chunks (1.88x from 13k to 26k).

**Cold-crawl wall numbers move with file-cache state, reproduced this sitting.** The 13k and
26k rows above (3.64 s, 7.27 s) read well above the last warm-confirmed figures (2.62 s,
5.07 s) -- the same effect pinned two sittings back: the first pass of the day reads high,
and only same-sitting same-cache comparisons are meaningful for this row. The in-process cold
build stayed linear and per-note proportionate (2004 ms at 13k, 4078 ms at 26k, a 2.03x step
for a 2x note count), confirming the wall-clock jump is cache state, not an engine
regression.

What the scale rows watch, in order of what actually breaks: the per-query freshness check (stats every file, linear, the cost every call pays), cold crawl (linear; a quadratic here was found and fixed at 13k/26k: FTS5 DELETE by column scans the whole table, and delete-before-insert ran per doc on cold builds where the table was empty), reconcile after updates (linear; dominated by whole-table link re-resolution plus a full PageRank pass), and the watcher race (a query during the watcher's bulk write transaction waits on `busy_timeout`, sized at 30s to cover ~3x the largest measured reconcile).

## Stress: the shape-cliff guard

`stress` is a pinned synthetic corpus (benchmark/lib/corpus.mjs) that packs every measured shape cliff into one 2,000-note tree: a 1 MB note, 200 headings per note, 100 links per note, 300 distinct frontmatter fields. Each cliff was found by the shape sweep (`benchmark/sweep.mjs`), fixed, and is held fixed by this row per release: `node benchmark/run.mjs . .tmp/cache/stress-stress-1`.

Measured 2026-08-22:

| metric | stress (2k notes, worst shapes) | guards |
|---|---|---|
| lexical `search` | 309 ms | bounded excerpt: snippet() never runs on docs past 16 KB; a JS best-window excerpt (with a `lines` section pointer) covers them |
| semantic `search` | 971 ms | brute-force scan over 402,000 chunks (201 per note); linear in chunks, not notes |
| cold crawl | 3.6 s (wall; see the file-cache note under Scale) | linear; heading-dense notes produce many chunks, all placeholder-only until the first semantic search |
| `peek` largest note (~255k t) | 62 ms / ~476 tokens | every peek list caps at 20 with true totals |
| `related` | 1.53 s / ~59 t | seed chunks sampled to 16: cost is `target_chunks x stored_chunks`, and 201 headings would otherwise multiply a full-corpus scan (12.7 s before the cap) |
| `map` (300 fields) | 89 ms / ~395 tokens | all per-column aggregates in one scan |
| in-process: update, 1 file touched | 15 ms | incremental link resolution; PageRank only when the edge set changed |
| bulk change (500 files): first query | 1.16 s | FTS delete by rowid; link rows diffed, not wiped |
| BM25 search (canonical join, raw SQL) | 9.0 s | **unguarded by design**: the canonical query calls snippet() directly, and raw SQL gets exactly what it asks for; `search` is the bounded path, and the skill documents the bound for hand-written SQL |

`map`'s token count moved 367 -> 395 (+28), the same recency-caveat line seen on the hub
corpus in Results above: stress is generated in one burst, so every file lands within one
majority second and the check fires here too. Bulk change (+5.5%) and the in-process
1-file update (14 -> 15 ms) move within this doc's noise band; nothing here crossed a
guarded cliff.

The sweep itself (`sweep.mjs`) re-runs when the engine changes, not per release; the probes it keeps (SQLite's 2,000-column limit fenced with a named error, adversarial markdown at ~8 s / 5 pathological notes with no timeout) are recorded in the findings file.

## Retrieval quality: nfcorpus

Results, nfcorpus (Apple Silicon, Node 26.7.0, 2026-08-22, local):

| metric | bm25 | fused | semantic |
|---|---|---|---|
| nDCG@10 | 0.3234 | 0.3234 | 0.3431 |
| MRR@10 | 0.5183 | 0.5183 | 0.5553 |
| hit@10 | 0.6873 | 0.6873 | 0.7121 |
| mean ms/query | 5.4 | 5.4 | 14.5 |

Paired deltas: semantic vs fused is 108W/77L on nDCG (z=2.3) and 16W/8L on hit (z=1.6) —
the same shape as the 0.6.0 measurement (110W/77L, z=2.4), so the semantic gain carried
through every release between.

## Retrieval quality: fever

Results, fever (Apple Silicon, Node 26.7.0, 2026-08-22, local):

| metric | bm25 | fused | semantic |
|---|---|---|---|
| nDCG@10 | 0.9435 | 0.9361 | 0.9343 |
| MRR@10 | 0.9508 | 0.9381 | 0.9352 |
| hit@10 | 0.9969 | 0.9971 | 0.9967 |
| mean ms/query | 9.1 | 18.1 | 22.3 |

Paired deltas: fused vs bm25 is 616W/680L on nDCG (z=-1.8); semantic vs fused is
1055W/963L (z=2.0), many small wins against fewer larger losses.

Regenerated 2026-08-27 as a release gate. bm25-only is digit-identical to the
2026-08-22 column; fused/semantic moved by 1e-4 (0.9360 -> 0.9361, 0.9344 ->
0.9343) with the same paired-delta shape. Attribution: the segmentation
contract fix (punctuation barriers, Intl.Segmenter graphemes, sidecar-only
routing) changes `_seg` tokens on pages containing CJK text, which shifts
global BM25 statistics enough to flip a handful of tie-adjacent ranks across
13,229 queries. nfcorpus (no CJK) stayed digit-identical through the same
changes, consistent with that attribution.

**The bm25 and fused columns are bit-stable against the 0.6.0 measurement** (0.9436/0.9361
then, 0.9435/0.9360 now, at 13,229 queries): five releases of changes left the lexical and
link layers untouched. **The semantic column drifted down** (0.9435 -> 0.9344 nDCG, 0.9479
-> 0.9352 MRR) somewhere in 0.7.x-0.11.x -- not attributable to any one release, because
the column was never regenerated between; the candidates are the fusion tuning and the
embed storage levers. This unattributable drift is what per-release regeneration
(`benchmark/release.mjs`) exists to prevent going forward. Bisecting the drift across the
published versions is possible if the ranking cost matters; the sign test says the net
per-query effect is still positive.

**Two eval-harness bugs were found and fixed this sitting, and they explain why the table
above went stale.** After the explicit-embed change (0.10.0), eval's embed variants no
longer named a model, so the semantic pass silently measured lexical; and eval still passed
a per-call `semantic` option the library had deliberately removed, so the guard pass was
measuring nothing. The two masked each other — with no embed block, the dead option never
mattered — and nothing surfaced because quality tables only regenerate when retrieval
changes. The rule that follows: eval columns regenerate whenever eval.mjs or the config
semantics it drives change, not only when ranking does.

Read:

- The published BEIR BM25 (Anserini) baseline for NFCorpus is nDCG@10 ≈ 0.32. The FTS5 pipeline matches it, so `find`'s lexical layer is a faithful BM25 rather than an approximation, and the identical fused column confirms link fusion is a no-op where there are no links.
- **The two corpora are the ends of one axis**, and no customer tree is either: NFCorpus is maximal vocabulary gap (layman queries, jargon documents; 31% of queries have no relevant document in the top 10), FEVER is zero gap (claims quote their evidence nearly verbatim, 99.7% hit@10 for plain BM25). A change that wins on one by losing on the other is fitted to a corpus nobody has.
- **Semantic expansion earns its cost where the gap is real**: +0.020 nDCG / +0.025 hit on NFCorpus (z=2.3). On FEVER it no longer recovers link fusion's ranking cost point-wise (0.9360 -> 0.9344 nDCG) though the sign test stays net-positive (z=2.2); see the drift note above.
- **Link fusion's own contribution is smaller than the fused column suggests.** Its score comes largely from PageRank restart mass sitting on the seed set, which re-ranks matches in near-match order; on FEVER it costs ~1 point of MRR by occasionally promoting neighbors above the true evidence page. Removing that restart mass was measured and rejected: it drops FEVER hit@10 to 0.907. `via` labels are gated on a real incident edge, so the labels stay honest even where the score echo remains.
