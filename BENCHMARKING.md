# Benchmarks

Per-release measurements on a public corpus. One column per release; add a column when a release changes performance or capability, and update the results tables below.

## Running

```bash
node benchmark/compare.mjs                             # released baseline (package.json) vs working tree
node benchmark/compare.mjs obsidian-hub 0.2.1 local    # explicit corpus and versions
node benchmark/eval.mjs nfcorpus                       # retrieval quality on a labeled corpus
```

The default run answers "did the working tree regress?" `local` is whatever is checked out. The working-tree column is labeled `local` until the release exists: regenerate the table at release time and the column gets its real number. Named corpora, dataset builds, and npm-installed comparison versions all cache through `benchmark/lib/cache.mjs` into `.tmp/cache/` (gitignored): fetched once, built atomically in a staging dir, safe to delete anytime. Corpus specs are pinned in `benchmark/lib/corpus.mjs`, the single source of truth. A directory path works in place of a corpus name.

`compare.mjs` installs each npm version into a temp dir (`local` = this working tree), gives every version an isolated copy of the tree with a v1 config (the lowest common denominator every version can read; copies keep cache formats and config auto-migration from cross-contaminating), runs `benchmark/run.mjs` per version, and prints the table. `run.mjs` can also run alone against any single package root + tree; it prints one JSON row.

Two kinds of metric per version:

- **Wall-time:** spawns the CLI per operation, so every number includes ~40 ms of Node startup. This is what a calling agent pays per invocation. On embed-enabled trees `run.mjs` also times `find --semantic` (`semantic_find_ms`); its delta over `find_ms` is the per-invocation semantic cost: model load, query embed, vector scan (null on trees without embed).
- **In-process:** imports the version's `dist/esm/index.js` as a library and times the engine alone: cold index build, the no-change freshness check, and incremental updates (1 file touched, 10 files modified). Pure Node, no platform dependence.

## Maintaining

- Regenerate **all** columns of a table in one sitting on one machine. Numbers are not comparable across machines or Node versions. Record machine + Node in the table caption.
- Regenerate **before** the version bump, not after publishing: a benchmark run is only a release gate if a bad number can still stop the release. See [RELEASING.md](RELEASING.md).
- The performance tables regenerate every release; the retrieval-quality tables regenerate when retrieval itself changes: fusion, ranking, the default model, tokenizer, chunking. A quality column older than the current version is expected, and says the ranking has not moved since; a retrieval change shipped without a fresh column is the gap to catch.
- To add a metric: one measured field in `run.mjs`, one row in the `ROWS` table in `compare.mjs`. Versions lacking a command report `—` automatically; a version that errors reports the error.
- Corpus pins live in `benchmark/lib/corpus.mjs`. If a pin must move (repo disappears, need a bigger corpus), regenerate every column at the new pin.

## Interpreting

- Timings are medians (wall: 5 runs, cold crawl 1; in-process: 5 no-change, 3 updates).
- Wall minus in-process ≈ per-invocation overhead: process spawn, Node/V8 startup, importing sense and its dependencies, argv parsing. The two move independently. If the in-process number grows, the engine (scan/reconcile/SQL) got slower; if the gap grows while in-process stays flat, startup got heavier, typically a new dependency imported at module top level, which every invocation pays for before any work happens. Commands lazy-load from `src/cli/` (cli.ts imports no tree code), so a heavy import belongs inside the one command that uses it; `--version` is the canary: it should stay at bare Node startup (~25 ms here).
- The update rows include everything reconcile does after re-parsing: link re-resolution across the whole table and a full PageRank pass. They are the numbers to watch as features add reconcile work.
- The bulk-change pair measures `watch`: without a watcher, the first query after many files change pays the whole reparse; with one running, the reparse happened in the background and the query pays only the freshness check.
- Token columns (`map`, `peek`, `find` row) are output-size contracts, not performance: they must stay roughly flat as trees grow. A token number that scales with tree size is a context-bloat regression even if timings look fine. The `find` row is measured in json, per row actually returned, and tracks summary and snippet length rather than tree size.
- Watch for: cold build growing worse than linearly with note count; the no-change check drifting above ~50 ms at 10k notes; the update rows drifting away from the freshness check they now track (update minus no-change is the real update work; it should stay in the tens of ms); any stress-table row moving (each guards a fixed shape cliff).

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
asserted in test/unit/fences.test.ts).

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

## Retrieval quality

`benchmark/eval.mjs <corpus>` runs every labeled query through the shipped library in four passes and reports nDCG@10, MRR@10 and hit@10 against the corpus qrels: **bm25-only** (links and rank off), **fused** (BM25 + link expansion), **fused-embed-configured** (the embed block present, the preset `semantic: false`; a hidden guard pass), and **semantic** (embed block present, preset semantic on). There is no per-call semantic switch: the preset decides, so the guard exercises the one lever a tree owner actually has. Queries are natural-language text submitted as an OR bag of words (the standard bag-of-words baseline; bare FTS5 terms AND-join and punctuation is syntax).

Two guards run before any number is reported:

- **Bit-identity.** The guard pass must return rows identical to fused, query for query; a divergence aborts the run with a nonzero exit. This is what makes "a semantic:false preset changes nothing on an embed-configured tree" a tested claim rather than a design intention.
- **Paired per-query deltas.** Point metrics hide whether a change moved many queries a little or a few queries a lot, and at these sample sizes a 0.01 difference can be noise. Every comparison also reports wins/losses and a sign-test z (|z| > 2 is beyond noise).

Labeled corpora convert their labels to one format (`labels/queries.jsonl` + `test.tsv`, read by `benchmark/lib/labels.mjs`):

- **nfcorpus:** BEIR NFCorpus, 3,633 medical abstracts, 323 queries, graded qrels (~38 judged/query). No links, so fused equals bm25-only; it measures lexical recall and the vocabulary gap semantic expansion targets.
- **fever:** FEVER dev split, 2,860 Wikipedia pages cited as evidence by 13,229 verifiable claims, with sentence link annotations kept as wikilinks. The claims are the queries; the corpus that can measure whether link fusion helps or hurts ranking.

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

### Static-model bake-off (semantic-search-design.md, sequence step 2)

`benchmark/bakeoff.mjs <corpus>` embeds a labeled corpus with the candidate static model, scores cosine-only and bm25+vector RRF (find's pool size and RRF constant) against the qrels, and prints each storage lever next to the acceptance thresholds. Model files fetch once into `.tmp/cache/`, pinned by revision like corpora. Doc vectors are stored per lever (sliced, re-normalized, optionally int8); queries stay f32.

Results: nfcorpus, 323 queries, `minishlab/potion-retrieval-32M@6fc8051f` (macOS arm64, Node 26, 2026-08-13). Model load 39 ms, embed 0.30 ms/doc:

| variant | nDCG@10 | MRR@10 | hit@10 | Δ nDCG | Δ hit | ms/query | vectors MB |
|---|---|---|---|---|---|---|---|
| bm25 (baseline) | 0.3233 | 0.5185 | 0.6873 | — | — | 0.7 | — |
| cosine f32-512 | 0.3086 | 0.5069 | 0.6842 | — | — | 1.2 | 7.4 |
| cosine f32-256 | 0.3019 | 0.5000 | 0.6749 | — | — | 0.6 | 3.7 |
| cosine f32-128 | 0.2875 | 0.4769 | 0.6656 | — | — | 0.3 | 1.9 |
| cosine int8-512 | 0.3085 | 0.5069 | 0.6842 | — | — | 1.2 | 1.9 |
| cosine int8-256 | 0.3022 | 0.5003 | 0.6749 | — | — | 0.6 | 0.9 |
| bm25+vec f32-512 | 0.3451 | 0.5583 | 0.7090 | +0.0218 | +0.0217 | 1.9 | 7.4 |
| bm25+vec f32-256 | 0.3432 | 0.5565 | 0.7152 | +0.0198 | +0.0279 | 1.3 | 3.7 |
| bm25+vec f32-128 | 0.3405 | 0.5458 | 0.7183 | +0.0172 | +0.0310 | 1.0 | 1.9 |
| bm25+vec int8-512 | 0.3453 | 0.5586 | 0.7090 | +0.0219 | +0.0217 | 1.9 | 1.9 |
| bm25+vec int8-256 | 0.3438 | 0.5564 | 0.7152 | +0.0204 | +0.0279 | 1.3 | 0.9 |

Read:

- The acceptance thresholds below were the bar for silent default-on fusion, superseded 2026-08-13 by the explicit-expansion reframe: the bar is now recall-when-invoked, which these numbers clear at every lever.
- **Fusion helps at every lever**: both nDCG and hit improve across the board, but **no lever clears both acceptance thresholds** (ΔnDCG ≥ +0.02 and Δhit ≥ +0.03): 512-dim clears nDCG and misses hit by 0.008; 128-dim clears hit and misses nDCG; 256-dim near-misses both. Latency passes everywhere (≤1.9 ms vs the 10 ms ceiling).
- **int8 storage is free**: identical quality to f32 at every dims setting, at ¼ the bytes. Whatever ships, vectors store quantized.
- **Cosine-only never beats BM25** (0.309 vs 0.323 at best), consistent with published results on this BM25-favoring dataset, so the pure-JS loader is faithful; and it confirms the design's recall-layer stance: vectors must fuse, never replace.
- The fusion here is untuned equal-weight RRF at pool 30. NFCorpus ships train/dev qrels (`labels/dev.tsv`, readable via `readLabels(dir, 'dev')`), so fusion-tuning levers can be tuned on dev and reported on test without touching the gate.

### 2026-08-27: release gates

`compare.mjs` vs 0.15.4: every row within same-sitting noise (wall deltas
6-9 ms; in-process cold build 1460 -> 1435 ms; token contracts flat at
~71/~496/~581). The provider architecture, weighted signals, lazy fetch,
language fit, and sidecar routing cost nothing measurable on the performance
surface. Retrieval gates: nfcorpus digit-identical throughout the cycle;
fever regenerated with a 1e-4 attributed movement (see its section).

### 2026-08-27: embedding model selection (W8)

Apple Silicon, Node 26.7.0, local Ollama daemon. Everything below regenerated this sitting: `nfcorpus` and the default model were already cached; `potion-base-8M`, `granite-embedding:30m`, `qwen3-embedding:0.6b`, and all four MIRACL corpora were fetched fresh, pinned by revision like every model and corpus in this repo.

**Continuity gate.** `eval.mjs nfcorpus` reproduces the 2026-08-22 table above digit-for-digit (nDCG@10 0.3234/0.3234/0.3431, MRR@10 0.5183/0.5183/0.5553, hit@10 0.6873/0.6873/0.7121, paired semantic-vs-fused 108W/77L z=2.3) across the W4 signals refactor landing in between (`semantic: false` -> `signals: [...]`). The eval-semantics change moved config keys, not scores. Separately, `bakeoff.mjs`'s own bm25+vec numbers (it runs its own RRF over a raw-SQL BM25 candidate list, not through `search()`/signals) drifted by <0.001 nDCG from the 2026-08-13 bake-off table above even though its cosine-only rows are bit-identical — a harness-vintage artifact of that same config-key rename in the harness's own BM25 candidate query, not a scoring change; noted for the record, not investigated further since the number that matters (`eval.mjs`, via `search()`) reproduces exactly.

**Bug found + fixed in `bakeoff.mjs`:** `LEVERS` was hardcoded to 512/256/128-dim assuming every model's native output is >=512 (true for potion-retrieval-32M, false for potion-base-8M and granite/qwen3's native dims). A lever wider than a model's native dims read past the vector (`undefined` -> `NaN`), silently producing near-zero garbage scores instead of an error. Fixed: levers are capped to `dims <= model's native dims`, and the caption now prints native dims.

#### Static ladder: does 8M's size justify the default?

`nfcorpus`, 323 queries. `minishlab/potion-retrieval-32M@6fc8051f` (cached, current default) vs `minishlab/potion-base-8M@bf8b0566` (30 MB fresh download: 30,236,760 B safetensors + 683,666 B tokenizer.json).

potion-retrieval-32M, native dims 512, load 40 ms, embed 0.30 ms/doc:

| variant | nDCG@10 | MRR@10 | hit@10 | Δ nDCG | Δ hit | ms/query | vectors MB |
|---|---|---|---|---|---|---|---|
| bm25 (baseline) | 0.3234 | 0.5183 | 0.6873 | — | — | 0.6 | — |
| cosine f32-512 | 0.3086 | 0.5069 | 0.6842 | — | — | 1.1 | 7.4 |
| cosine int8-256 | 0.3022 | 0.5003 | 0.6749 | — | — | 0.6 | 0.9 |
| bm25+vec f32-512 | 0.3460 | 0.5583 | 0.7090 | +0.0226 | +0.0217 | 1.7 | 7.4 |
| bm25+vec int8-256 | 0.3444 | 0.5568 | 0.7152 | +0.0210 | +0.0279 | 1.2 | 0.9 |

potion-base-8M, native dims 256 (a lever wider than 256 is invalid for this model, so there is no f32-512 row), load 16 ms, embed 0.30 ms/doc:

| variant | nDCG@10 | MRR@10 | hit@10 | Δ nDCG | Δ hit | ms/query | vectors MB |
|---|---|---|---|---|---|---|---|
| bm25 (baseline) | 0.3234 | 0.5183 | 0.6873 | — | — | 0.6 | — |
| cosine f32-256 (native) | 0.2440 | 0.4383 | 0.6130 | — | — | 0.6 | 3.7 |
| cosine int8-256 | 0.2441 | 0.4375 | 0.6130 | — | — | 0.6 | 0.9 |
| bm25+vec f32-256 (native) | 0.3227 | 0.5290 | 0.7152 | -0.0006 | +0.0279 | 1.3 | 3.7 |
| bm25+vec int8-256 | 0.3234 | 0.5313 | 0.7152 | +0.0000 | +0.0279 | 1.3 | 0.9 |

Read: potion-base-8M is ~4x smaller (30 MB vs 129 MB) but at the shipped int8-256 lever its fused nDCG lift over BM25 is +0.0000 against potion-retrieval-32M's +0.0210 — no ranking lift at all vs a real one, and its cosine-only quality is well behind (0.2441 vs 0.3022 int8-256). The hit@10 lift (+0.0279) is identical between the two models at int8-256, so the smaller model still recovers as many BM25-missed hits, just ranks what it recovers much worse. Deltas only; the size-vs-quality trade-off is the tree owner's call.

#### Encoder tier via Ollama

`nfcorpus`, 323 queries, embedded through the shipped `openai` provider (`dist/esm/embed/openai.js`) against Ollama's `/v1/embeddings`, batched at its 64-doc cap. Downloads: `granite-embedding:30m` 62 MB, `qwen3-embedding:0.6b` 639 MB (`ollama pull`, sizes from `ollama list`).

granite-embedding:30m, native dims 384, embed 6.65 ms/doc, query embed 11.5 ms/query:

| variant | nDCG@10 | MRR@10 | hit@10 | Δ nDCG | Δ hit | ms/query | vectors MB |
|---|---|---|---|---|---|---|---|
| bm25 (baseline) | 0.3234 | 0.5183 | 0.6873 | — | — | 2.0 | — |
| cosine int8-256 | 0.3139 | 0.4991 | 0.6842 | — | — | 0.7 | 0.9 |
| cosine f32-384 (native) | 0.3332 | 0.5222 | 0.6997 | — | — | 1.0 | 5.6 |
| bm25+vec int8-256 | 0.3585 | 0.5742 | 0.7368 | +0.0351 | +0.0495 | 2.8 | 0.9 |
| bm25+vec f32-384 (native) | 0.3653 | 0.5736 | 0.7399 | +0.0419 | +0.0526 | 3.0 | 5.6 |

qwen3-embedding:0.6b, native dims 1024, embed 89.96 ms/doc, query embed 25.5 ms/query — runs **without** its optional query instruction (the shipped provider is symmetric per D7's current scope), so these numbers are a floor, not its ceiling:

| variant | nDCG@10 | MRR@10 | hit@10 | Δ nDCG | Δ hit | ms/query | vectors MB |
|---|---|---|---|---|---|---|---|
| bm25 (baseline) | 0.3234 | 0.5183 | 0.6873 | — | — | 4.2 | — |
| cosine int8-256 | 0.2470 | 0.4253 | 0.6068 | — | — | 0.8 | 0.9 |
| cosine f32-1024 (native) | 0.2987 | 0.4884 | 0.6873 | — | — | 2.5 | 14.9 |
| bm25+vec int8-256 | 0.3449 | 0.5564 | 0.7523 | +0.0215 | +0.0650 | 4.9 | 0.9 |
| bm25+vec f32-1024 (native) | 0.3615 | 0.5737 | 0.7523 | +0.0381 | +0.0650 | 6.7 | 14.9 |

Read: both encoders beat every static-ladder fused number by a wide margin. granite-embedding:30m — the smallest encoder tested, 30M params, roughly the same download as potion-base-8M — is the only model measured this sitting to clear both superseded silent-fusion thresholds (ΔnDCG >= +0.02, Δhit >= +0.03) at any lever, static or encoder. qwen3, even at its measured floor, posts the largest hit@10 lift of anything measured (+0.0650), though its cosine-only numbers trail granite's at matched int8-256 — consistent with F2's MTEB ranking (qwen3 highest) combined with int8-256 cutting its 1024 native dims by 75% vs granite's 384, a proportionally deeper cut. The cost is latency: qwen3 embeds at ~90 ms/doc vs the static tier's ~0.3 ms/doc — local daemon inference, not network.

#### MIRACL per-language

Per-language corpora built by `benchmark/lib/corpus.mjs`'s new `miracl` builder, following the fever pattern: judged docs (all of them, both relevance grades) are a floor and never trimmed; a reservoir-sampled (seeded), pinned set of distractors pads toward ~3-5k docs only when the judged set falls short of it. Both HF datasets pinned by commit sha: `miracl/miracl@5be20db9` (topics + qrels; the dev split is the only publicly-labeled one and stands in as this harness's "test" split), `miracl/miracl-corpus@d921ec7e` (passages, gzipped jsonl shards with no docid->shard index, so every shard is scanned once to pull out judged docs and sample distractors).

| lang | judged docs | distractors | total docs | queries | shards scanned | build wall time |
|---|---|---|---|---|---|---|
| zh | 3,786 | 214 | 4,000 | 393 | 10 | 45 s |
| ja | 8,066 | 0 (already over target) | 8,066 | 860 | 14 | 68 s |
| ru | 12,607 | 0 (already over target) | 12,607 | 1,252 | 20 | 102 s |
| de | 3,103 | 897 | 4,000 | 305 | 32 | 155 s |

ja and ru's qrels alone judge more passages than the ~3-5k target, so per the floor rule they ship at their natural (larger) size with zero sampled distractors rather than being trimmed to fit.

**Second harness bug found + fixed: `orBag` (`benchmark/lib/labels.mjs`) assumed word-spaced script.** `text.match(/[\p{L}\p{N}]+/gu)` merges an entire Han/Hiragana/Katakana run into one token — there are no spaces to split on — so the OR-bag became a single, near-unmatchable phrase per query. Measured on miracl-zh before the fix: BM25 nDCG@10 0.0119, hit@10 0.0204 (chance level). Fixed by splitting CJK-script runs to one-character unigrams, Lucene's `StandardTokenizer` default for CJK (already cited in PRINCIPLES.md F4); word-spaced runs (Latin, Cyrillic) are untouched, and `nfcorpus` was re-verified digit-identical after the change. Post-fix, miracl-zh BM25 is a real baseline: nDCG@10 0.4943, hit@10 0.8601.

Default static model (`potion-retrieval-32M@6fc8051f`) per language:

miracl-zh (4,000 docs, 393 queries):

| variant | nDCG@10 | MRR@10 | hit@10 | Δ nDCG | Δ hit | ms/query |
|---|---|---|---|---|---|---|
| bm25 (baseline) | 0.4943 | 0.4389 | 0.8601 | — | — | 1.7 |
| cosine f32-512 | 0.1573 | 0.1649 | 0.3537 | — | — | 1.3 |
| cosine int8-256 | 0.1649 | 0.1707 | 0.3690 | — | — | 0.7 |
| bm25+vec f32-512 | 0.3890 | 0.3754 | 0.7710 | -0.1053 | -0.0891 | 3.1 |
| bm25+vec int8-256 | 0.3923 | 0.3800 | 0.7659 | -0.1020 | -0.0941 | 2.4 |

miracl-ja (8,066 docs, 860 queries):

| variant | nDCG@10 | MRR@10 | hit@10 | Δ nDCG | Δ hit | ms/query |
|---|---|---|---|---|---|---|
| bm25 (baseline) | 0.4929 | 0.4656 | 0.7814 | — | — | 14.2 |
| cosine f32-512 | 0.1926 | 0.2164 | 0.3884 | — | — | 2.7 |
| cosine int8-256 | 0.1892 | 0.2130 | 0.3756 | — | — | 1.3 |
| bm25+vec f32-512 | 0.4303 | 0.4299 | 0.7535 | -0.0625 | -0.0279 | 16.9 |
| bm25+vec int8-256 | 0.4315 | 0.4336 | 0.7512 | -0.0614 | -0.0302 | 15.5 |

miracl-ru (12,607 docs, 1,252 queries):

| variant | nDCG@10 | MRR@10 | hit@10 | Δ nDCG | Δ hit | ms/query |
|---|---|---|---|---|---|---|
| bm25 (baseline) | 0.4783 | 0.4923 | 0.7668 | — | — | 2.6 |
| cosine f32-512 | 0.1087 | 0.1453 | 0.2748 | — | — | 4.1 |
| cosine int8-256 | 0.0990 | 0.1340 | 0.2492 | — | — | 2.0 |
| bm25+vec f32-512 | 0.3859 | 0.4384 | 0.7308 | -0.0924 | -0.0359 | 6.6 |
| bm25+vec int8-256 | 0.3830 | 0.4377 | 0.7276 | -0.0953 | -0.0391 | 4.6 |

miracl-de (4,000 docs, 305 queries):

| variant | nDCG@10 | MRR@10 | hit@10 | Δ nDCG | Δ hit | ms/query |
|---|---|---|---|---|---|---|
| bm25 (baseline) | 0.5279 | 0.4935 | 0.8852 | — | — | 1.4 |
| cosine f32-512 | 0.4019 | 0.4344 | 0.7311 | — | — | 1.4 |
| cosine int8-256 | 0.3697 | 0.4043 | 0.6951 | — | — | 0.7 |
| bm25+vec f32-512 | 0.5227 | 0.5102 | 0.8852 | -0.0052 | 0.0000 | 2.7 |
| bm25+vec int8-256 | 0.5168 | 0.5105 | 0.8820 | -0.0112 | -0.0033 | 2.1 |

Read: the default English static model measurably hurts every one of these four languages when fused — every Δ nDCG, and every Δ hit except German's (flat), is negative. Severity tracks script/vocabulary distance from English: zh/ja cosine-only is near-random (0.10-0.19 nDCG vs BM25's ~0.49) and fusion costs 6-10 points of nDCG; German (Latin script, shared subwords and named entities with English) keeps real cosine-only signal (0.40 vs BM25's 0.53) and fusion's cost is much smaller (-0.005 to -0.01 nDCG, hit@10 unchanged at f32-512). Russian (Cyrillic, no shared subwords, still word-spaced) sits at zh/ja-like severity despite being a word-spaced script — script alone doesn't predict this, vocabulary overlap does. This is F5's prediction (the default model fails outside English), now measured rather than assumed, on four real per-language corpora rather than a token-loss proxy.

qwen3-embedding:0.6b per language (same floor caveat as the English encoder table: no query instruction):

miracl-zh, embed 37.55 ms/doc:

| variant | nDCG@10 | MRR@10 | hit@10 | Δ nDCG | Δ hit | ms/query |
|---|---|---|---|---|---|---|
| bm25 (baseline) | 0.4943 | 0.4389 | 0.8601 | — | — | 4.7 |
| cosine int8-256 | 0.7324 | 0.7049 | 0.9898 | — | — | 0.8 |
| cosine f32-1024 (native) | 0.7577 | 0.7360 | 0.9898 | — | — | 2.8 |
| bm25+vec int8-256 | 0.6633 | 0.6208 | 0.9695 | +0.1691 | +0.1094 | 5.5 |
| bm25+vec f32-1024 (native) | 0.6601 | 0.6181 | 0.9695 | +0.1658 | +0.1094 | 7.5 |

miracl-de, embed 48.95 ms/doc:

| variant | nDCG@10 | MRR@10 | hit@10 | Δ nDCG | Δ hit | ms/query |
|---|---|---|---|---|---|---|
| bm25 (baseline) | 0.5279 | 0.4935 | 0.8852 | — | — | 3.5 |
| cosine int8-256 | 0.7485 | 0.7251 | 0.9770 | — | — | 0.8 |
| cosine f32-1024 (native) | 0.7582 | 0.7321 | 0.9836 | — | — | 2.8 |
| bm25+vec int8-256 | 0.6778 | 0.6556 | 0.9705 | +0.1499 | +0.0852 | 4.3 |
| bm25+vec f32-1024 (native) | 0.6711 | 0.6486 | 0.9639 | +0.1432 | +0.0787 | 6.2 |

miracl-ja, embed 62.68 ms/doc:

| variant | nDCG@10 | MRR@10 | hit@10 | Δ nDCG | Δ hit | ms/query |
|---|---|---|---|---|---|---|
| bm25 (baseline) | 0.4929 | 0.4656 | 0.7814 | — | — | 17.2 |
| cosine int8-256 | 0.7512 | 0.7383 | 0.9802 | — | — | 1.4 |
| cosine f32-1024 (native) | 0.7779 | 0.7662 | 0.9860 | — | — | 5.6 |
| bm25+vec int8-256 | 0.6739 | 0.6414 | 0.9570 | +0.1810 | +0.1756 | 18.6 |
| bm25+vec f32-1024 (native) | 0.6733 | 0.6404 | 0.9570 | +0.1804 | +0.1756 | 22.7 |

miracl-ru, embed 82.79 ms/doc:

| variant | nDCG@10 | MRR@10 | hit@10 | Δ nDCG | Δ hit | ms/query |
|---|---|---|---|---|---|---|
| bm25 (baseline) | 0.4783 | 0.4923 | 0.7668 | — | — | 6.2 |
| cosine int8-256 | 0.7697 | 0.7872 | 0.9776 | — | — | 2.2 |
| cosine f32-1024 (native) | 0.7874 | 0.7983 | 0.9832 | — | — | 8.7 |
| bm25+vec int8-256 | 0.6667 | 0.6681 | 0.9617 | +0.1884 | +0.1949 | 8.4 |
| bm25+vec f32-1024 (native) | 0.6628 | 0.6653 | 0.9545 | +0.1846 | +0.1877 | 14.9 |

Read: qwen3 is dramatically better than BM25 on every language measured (cosine-only nDCG 0.73-0.79 vs BM25's 0.48-0.53), confirming F2/F5's prediction that an encoder over HTTP, not a static model, is the real multilingual path — and this holds even at the measured floor (no query instruction). The one consistent surprise: **RRF fusion makes every language's ranking worse than cosine-only alone**, not better (e.g. miracl-ru cosine-only 0.7874 vs bm25+vec 0.6628 at f32-1024) — fusion still beats the BM25 baseline by a wide margin (+0.14 to +0.19 nDCG), just not by as much as dropping BM25 from the blend entirely would. This is the mirror image of the English nfcorpus case, where BM25 is the stronger signal and fusion helps; here vectors are so much stronger than BM25 that equal-weight RRF pulls the blended ranking down toward the weaker signal. Untuned equal-weight fusion (this harness's RRF, matching `find`'s defaults) is not the right policy when one signal dominates this heavily — a per-language or per-preset fusion weight, not a fixed constant, is what these numbers argue for, consistent with F3's finding that fusion policy is corpus/model-contingent, not universal.

#### Signal weight sweep (2026-08-27)

W8's per-preset `signals` weight (a preset's `signals` map each name to its RRF weight, `weight / (RRF_K + rank)`; weight 1 is the default and reproduces the equal-weight numbers above digit-for-digit) measured with `benchmark/weight-sweep.mjs`, which runs the same BM25-SQL-plus-weighted-RRF scoring as `bakeoff.mjs`/`bakeoff-http.mjs` (not `search()`/`eval.mjs`'s signals path). Two corpora: nfcorpus (323 queries, test split) with the default static model at its native f32-512, and miracl-zh (393 queries) with `qwen3-embedding:0.6b` over the Ollama HTTP path at native f32-1024 (same floor caveat as the encoder tables above: no query instruction).

nfcorpus, `minishlab/potion-retrieval-32M@6fc8051f`:

| variant | nDCG@10 | MRR@10 | hit@10 |
|---|---|---|---|
| bm25 only | 0.3234 | 0.5183 | 0.6873 |
| bm25 + vectors×0.5 | 0.3446 | 0.5594 | 0.7121 |
| bm25 + vectors×1 | 0.3460 | 0.5583 | 0.7090 |
| bm25 + vectors×2 | 0.3353 | 0.5455 | 0.6966 |
| bm25 + vectors×4 | 0.3320 | 0.5400 | 0.6997 |
| vectors only (cosine) | 0.3086 | 0.5069 | 0.6842 |

miracl-zh, `qwen3-embedding:0.6b` via Ollama:

| variant | nDCG@10 | MRR@10 | hit@10 |
|---|---|---|---|
| bm25 only | 0.4943 | 0.4389 | 0.8601 |
| bm25 + vectors×0.5 | 0.6169 | 0.5698 | 0.9389 |
| bm25 + vectors×1 | 0.6601 | 0.6181 | 0.9695 |
| bm25 + vectors×2 | 0.6948 | 0.6607 | 0.9771 |
| bm25 + vectors×4 | 0.7190 | 0.6878 | 0.9796 |
| vectors only (cosine) | 0.7577 | 0.7360 | 0.9898 |

Read: the two corpora disagree about which direction to move the weight. On nfcorpus, nDCG peaks at weight 0.5 (0.3446), weight 1 is within noise of that peak (0.3460), and every weight above 1 is worse than bm25-only fusion at weight 1 and worse than bm25 alone dropping below 0.335 by weight 4; bm25 stays the stronger signal here, so pulling weight toward vectors pulls the ranking toward the weaker one. On miracl-zh, nDCG rises monotonically with weight across the entire swept range and never turns over: 0.6601 at weight 1, 0.7190 at weight 4, still short of vectors-only's 0.7577 — vectors are so much stronger than bm25 here that every step away from equal weight and toward vectors-only helps, matching the per-language table above. No weight in {0.5, 1, 2, 4} is best for both corpora at once, and neither is "always raise the vectors weight" or "always leave it at 1" — the two curves move in opposite directions from the same starting point, which is what a per-preset weight is for. Which weight a given preset should carry is the tree owner's call, made against a table like this one for that preset's own model and corpus.

## Capabilities

| | 0.2.1 | 0.3.0 | 0.6.0 | 0.7.2 | 0.8.0 | 0.9.5 | 0.10.0 | 0.12.1 |
|---|---|---|---|---|---|---|---|---|
| frontmatter filter + FTS5 search | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| links table, backlinks, dead links | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| sections table, outline with line ranges | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| PageRank (`_rank`), hub detection | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| fused retrieval (`find`, `via` column) | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| bounded orient/structure commands (`map`, `peek`) | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| lenient frontmatter (syntax errors → warnings, values kept) | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| config auto-migration | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| feature toggles | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `--version` | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| semantic expansion (`features.embed`, `find --semantic`, `via: vector`) | — | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| feature state reported by `map` and `status` | — | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| labeled-corpus retrieval eval (nDCG/MRR/hit, paired deltas) | — | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| saved-query assertions (`sense check`, `checks`) | — | — | — | ✓ | ✓ | ✓ | ✓ | — |
| tree-declared find scope (`defaults.find.where`) | — | — | — | ✓ | ✓ | ✓ | ✓ | ✓ |
| `similarity` on semantic rows | — | — | — | ✓ | ✓ | ✓ | ✓ | ✓ |
| scale corpora (13k / 26k) measured per release | — | — | — | ✓ | ✓ | ✓ | ✓ | ✓ |
| saved finds (`queries` object form, `sense <name>` with baked-in settings) | — | — | — | — | ✓ | ✓ | ✓ | ✓ |
| bounded excerpts + `lines` on every `find` row | — | — | — | — | ✓ | ✓ | ✓ | ✓ |
| incremental link resolution; PageRank only on edge changes | — | — | — | — | ✓ | ✓ | ✓ | ✓ |
| derived `busy_timeout` (from observed reconcile, in `status`) | — | — | — | — | ✓ | ✓ | ✓ | ✓ |
| progress on stderr for long builds (TTY-aware, sparse when piped) | — | — | — | — | ✓ | ✓ | ✓ | ✓ |
| column-limit fence (named error at SQLite's 2,000) | — | — | — | — | ✓ | ✓ | ✓ | ✓ |
| stress corpus in the release gate | — | — | — | — | ✓ | ✓ | ✓ | ✓ |
| presets (config v3: one bundle for scope + settings; indexing derived) | — | — | — | — | — | ✓ | ✓ | ✓ |
| `search` verb (words + links + vectors fused by default) | — | — | — | — | — | ✓ | ✓ | ✓ |
| per-preset derived embedding (semantic-off presets cost no vectors) | — | — | — | — | — | ✓ | ✓ | ✓ |
| per-preset coverage in `status`/`map`; named rebuild notices | — | — | — | — | — | ✓ | ✓ | ✓ |
| `sql` verb (ad-hoc SQL; `query` renamed, one release of a pointer) | — | — | — | — | — | — | ✓ | ✓ |
| explicit `embed` block (config v4: model named in the file, no implicit default) | — | — | — | — | — | — | ✓ | ✓ |
| `sense download` (nothing fetches the model implicitly; a missing model is an error) | — | — | — | — | — | — | ✓ | ✓ |
| `queries` entries name their verb (`{ sql }` / `{ search }`, no bare-string shorthand) | — | — | — | — | — | — | ✓ | ✓ |
| link-graph route between two notes (`sense path`, bounded SQL traversal) | — | — | — | — | — | — | ✓ | ✓ |
| similar-but-unlinked (`sense related`, seed chunks sampled to bound the scan) | — | — | — | — | — | — | ✓ | ✓ |
| scope vocabulary on `map`/`peek`/`path`/`related` (`--exclude`, `--no-exclude`) | — | — | — | — | — | — | ✓ | ✓ |
| zero-dependency file walk (`node:fs` glob; POSIX paths on every platform) | — | — | — | — | — | — | ✓ | ✓ |
| quarantined frontmatter (a refused parse writes no columns; `_parse_error` says why) | — | — | — | — | — | — | — | ✓ |
| csv output; `sql` rows streamed, not materialized (`--format csv`, bigint-safe json) | — | — | — | — | — | — | — | ✓ |
| `content.tokenize` (per-tree FTS5 tokenizer; a tokenize-only change keeps vectors, links, sections) | — | — | — | — | — | — | — | ✓ |
| unspaced-script word search (grapheme sidecars, substring semantics, `segment()` SQL function) | — | — | — | — | — | — | — | ✓ |
| reserved-character scalars accepted by policy (`aliases: [@handle]`, tested per shape) | — | — | — | — | — | — | — | ✓ |
| unrendered-template detection (`created: {{date}}`, named with its path) | — | — | — | — | — | — | — | ✓ |
| embeddings cover the body, not the frontmatter block | — | — | — | — | — | — | — | ✓ |
| `similarity` clamped to a true cosine range | — | — | — | — | — | — | — | ✓ |
| `related` names every unanswerable case (no model, semantic-off scope, empty seed) | — | — | — | — | — | — | — | ✓ |
| `sql --preset` (binds a `scope` table to join; scopes FTS5 `MATCH` too) | — | — | — | — | — | — | — | ✓ |
| `status` names every location and derived value (config, cache, model dir, api key state) | — | — | — | — | — | — | — | ✓ |
