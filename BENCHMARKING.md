# Benchmarks

Per-release measurements on a public corpus. One column per release; add a column when a release
changes performance or capability, and update the results tables below.

## Running

```bash
node benchmark/compare.mjs                             # released baseline (package.json) vs working tree
node benchmark/compare.mjs obsidian-hub 0.2.1 local    # explicit corpus and versions
node benchmark/eval.mjs nfcorpus                       # retrieval quality on a labeled corpus
```

The default run answers "did the working tree regress?" — no publishing required; `local` is
whatever is checked out. The working-tree column is labeled `local` until the release exists:
regenerate the table at release time and the column gets its real number. Named corpora,
dataset builds, and npm-installed comparison versions all cache through `benchmark/lib/cache.mjs`
into `.tmp/cache/` (gitignored): fetched once, built atomically in a staging dir, safe to delete
anytime. Corpus specs are pinned in `benchmark/lib/corpus.mjs` — the single source of truth.
A directory path works in place of a corpus name.

`compare.mjs` does the whole flow: installs each npm version into a temp dir (`local` = this
working tree), gives every version an isolated copy of the tree with a v1 config (the lowest
common denominator every version can read; copies keep cache formats and config auto-migration
from cross-contaminating), runs `benchmark/run.mjs` per version, and prints the table. `run.mjs` can
also run alone against any single package root + tree; it prints one JSON row.

Two kinds of metric per version:

- **Wall-time** — spawns the CLI per operation, so every number includes ~40 ms of Node startup.
  This is what a calling agent pays per invocation. On embed-enabled trees `run.mjs` also
  times `find --semantic` (`semantic_find_ms`); its delta over `find_ms` is the per-invocation
  semantic cost — model load, query embed, vector scan (null on trees without embed).
- **In-process** — imports the version's `dist/esm/index.js` as a library and times the engine
  alone: cold index build, the no-change freshness check, and incremental updates (1 file
  touched, 10 files modified). Pure Node, no platform dependence.

## Maintaining

- Regenerate **all** columns of a table in one sitting on one machine — numbers are not
  comparable across machines or Node versions. Record machine + Node in the table caption.
- Regenerate **before** the version bump, not after publishing: a benchmark run is only a
  release gate if a bad number can still stop the release. See [RELEASING.md](RELEASING.md).
- The performance tables regenerate every release; the retrieval-quality tables regenerate
  when retrieval itself changes — fusion, ranking, the default model, tokenizer, chunking.
  A quality column older than the current version is expected, and says the ranking has not
  moved since; a retrieval change shipped without a fresh column is the gap to catch.
- To add a metric: one measured field in `run.mjs`, one row in the `ROWS` table in `compare.mjs`.
  Versions lacking a command report `—` automatically; a version that errors reports the error.
- Corpus pins live in `benchmark/lib/corpus.mjs`. If a pin must move (repo disappears, need a
  bigger corpus), regenerate every column at the new pin.

## Interpreting

- Timings are medians (wall: 5 runs, cold crawl 1; in-process: 5 no-change, 3 updates).
- Wall minus in-process ≈ per-invocation overhead: process spawn, Node/V8 startup, importing
  sense and its dependencies, argv parsing. The two move independently — if the in-process number
  grows, the engine (scan/reconcile/SQL) got slower; if the gap grows while in-process stays
  flat, startup got heavier — typically a new dependency imported at module top level, which
  every invocation pays for before any work happens. Commands lazy-load from `src/cli/`
  (cli.ts imports no tree code), so a heavy import belongs inside the one command that uses it;
  `--version` is the canary: it should stay at bare Node startup (~25 ms here).
- The update rows include everything reconcile does after re-parsing: link re-resolution across
  the whole table and a full PageRank pass. They are the numbers to watch as features add
  reconcile work.
- The bulk-change pair measures `watch`: without a watcher, the first query after many files
  change pays the whole reparse; with one running, the reparse happened in the background and
  the query pays only the freshness check.
- Token columns (`map`, `peek`, `find` row) are output-size contracts, not performance: they
  must stay roughly flat as trees grow. A token number that scales with tree size is a
  context-bloat regression even if timings look fine. The `find` row is measured in json,
  per row actually returned, and tracks summary and snippet length rather than tree size.
- Watch for: cold build growing worse than linearly with note count; the no-change check
  drifting above ~50 ms at 10k notes; the update rows drifting away from the freshness
  check they now track (update minus no-change is the real update work — it should stay
  in the tens of ms); any stress-table row moving (each guards a fixed shape cliff).

## Results — obsidian-hub @ b11036f9 (6,566 notes, 14 MB)

Apple Silicon, Node 26.7.0. 2026-08-15. `local` is the working tree about to be released;
the baseline column is whatever `package.json` names, so a bare `compare.mjs` always reads
"last release vs what ships next".

| metric | 0.7.2 | local |
|---|---|---|
| cold crawl (wall) | 944 ms | 1021 ms |
| warm query (`COUNT(*)`) | 74 ms | 73 ms |
| BM25 search (canonical join) | 81 ms | 81 ms |
| `find` (BM25 + link fusion) | 137 ms | 134 ms |
| `find` row size (json) | ~66 tokens | ~70 tokens |
| `map` (orient) | 81 ms / ~469 tokens | 79 ms / ~469 tokens |
| `peek` largest note (~77,274 t) | 78 ms / ~581 tokens (0.8%) | 76 ms / ~581 tokens (0.8%) |
| bulk change (500 files): first query | 1.17 s | 204 ms |
| bulk change (500 files): with warm watcher | 103 ms | 104 ms |
| in-process: cold index build | 925 ms | 1004 ms |
| in-process: freshness check, no change | 29.5 ms | 29.1 ms |
| in-process: update, 1 file touched | 124 ms | 30 ms |
| in-process: update, 10 files modified | 141 ms | 31 ms |

The update rows are the release: incremental link resolution, PageRank skipped when the
edge set is unchanged, and FTS deletes by rowid instead of an unindexed-column scan take
updates from ~124 ms to ~30 ms and the 500-file bulk change from 1.17 s to 204 ms
(plans/performance-findings.md). Two movements are intended, not noise: cold build is ~8%
slower (diff-style upserts that preserve rowids and link resolutions cost more on first
insert — the price of the update wins), and a `find` row grew 4 tokens because `lines` is
now always present (the section pointer that used to exist only under `--semantic`).

Release history on this corpus: 0.2.1 could not index it at all (one `@`-prefixed YAML alias
aborted the whole crawl; 0.3.0's lenient parser turned that into a per-file warning). 0.5.0
took 5.65 s to crawl it; 0.6.0 brought that to 0.94 s by removing a per-document FTS5 delete
on cold builds, and it has stayed under a second since (details under Scale).

## Scale

The README claims linear scaling and links here rather than carrying figures of its own, so
this is the measurement behind it. `obsidian-hub-x2` and `obsidian-hub-x4` (13k / 26k notes)
are named corpora that replicate the pinned hub tree N times under one root — real notes,
real frontmatter, real links, regenerated from nothing like every corpus. Duplicate basenames
across copies stress link-ambiguity resolution harder than a natural tree. Run
`node benchmark/run.mjs . <corpusPath>` per tree; regenerate scale rows together with the
main table.

Measured 2026-08-15, same machine and sitting as the table above (the `local` column):

| metric | 6.5k (hub) | 13k (x2) | 26k (x4) |
|---|---|---|---|
| cold crawl (wall) | 1.02 s | 3.08 s | 6.11 s |
| warm query | 73 ms | 101 ms | 148 ms |
| `find` | 134 ms | 202 ms | 334 ms |
| `map` | 79 ms / ~469 t | 112 ms / ~540 t | 169 ms / ~540 t |
| bulk change (500 files): first query | 204 ms | 244 ms | 324 ms |
| bulk change (500 files): with warm watcher | 104 ms | 124 ms | 177 ms |
| in-process: freshness check, no change | 29 ms | 52 ms | 98 ms |
| in-process: update, 1 file touched | 30 ms | 53 ms | 102 ms |

Every row is linear or better in note count across a 4x range. The freshness check — the
cost every single invocation pays — is 98 ms at 26k notes, and updates now track it (the
update work itself is the changed files' share, not the tree's). `map` and `peek` token
counts stay flat by construction, which is the contract that matters for context.

What the scale rows watch, in order of what actually breaks: the per-query freshness
check (stats every file — linear, the cost every call pays), cold crawl (linear —
a quadratic here was found and fixed at 13k/26k: FTS5 DELETE by column scans the whole
table, and delete-before-insert ran per doc on cold builds where the table was empty),
reconcile after updates (linear; dominated by whole-table link re-resolution plus a full
PageRank pass), and the watcher race (a query during the watcher's bulk write transaction
waits on `busy_timeout` — sized at 30s to cover ~3x the largest measured reconcile).

## Stress — the shape-cliff guard

`stress` is a pinned synthetic corpus (benchmark/lib/corpus.mjs) that packs every measured
shape cliff into one 2,000-note tree: a 1 MB note, 200 headings per note, 100 links per
note, 300 distinct frontmatter fields. Each cliff was found by the shape sweep
(`benchmark/sweep.mjs`, dimensions and full history in plans/performance-findings.md),
fixed, and is held fixed by this row per release: `node benchmark/run.mjs .
.tmp/cache/stress-stress-1`.

Measured 2026-08-15, same sitting:

| metric | stress (2k notes, worst shapes) | guards |
|---|---|---|
| `find` | 303 ms | bounded excerpt: snippet() never runs on docs past 16 KB; a JS best-window excerpt (with a `lines` section pointer) covers them |
| `peek` largest note (~255k t) | 54 ms / ~476 tokens | every peek list caps at 20 with true totals |
| `map` (300 fields) | 72 ms / ~355 tokens | all per-column aggregates in one scan |
| in-process: update, 1 file touched | 12 ms | incremental link resolution; PageRank only when the edge set changed |
| bulk change (500 files): first query | 891 ms | FTS delete by rowid; link rows diffed, not wiped |
| BM25 search (canonical join, raw SQL) | 8.9 s | **unguarded by design** — the canonical query calls snippet() directly, and raw SQL gets exactly what it asks for; `find` is the bounded path, and the skill documents the bound for hand-written SQL |

The sweep itself (`sweep.mjs`) re-runs when the engine changes, not per release; the probes
it keeps (SQLite's 2,000-column limit fenced with a named error, adversarial markdown at
~8 s / 5 pathological notes with no timeout) are recorded in the findings file.

## Retrieval quality

`benchmark/eval.mjs <corpus>` runs every labeled query through the shipped library in four
passes and reports nDCG@10, MRR@10 and hit@10 against the corpus qrels: **bm25-only**
(links and rank off), **fused** (BM25 + link expansion), **embed-on** (the feature enabled
but never invoked), and **semantic** (`--semantic` expansion invoked). Queries are
natural-language text submitted as an OR bag of words (the standard bag-of-words baseline;
bare FTS5 terms AND-join and punctuation is syntax).

Two guards run before any number is reported:

- **Bit-identity.** The embed-on pass must return rows identical to fused, query for query;
  a divergence aborts the run with a nonzero exit. This is what makes "enabling the feature
  changes nothing until you ask for it" a tested claim rather than a design intention.
- **Paired per-query deltas.** Point metrics hide whether a change moved many queries a
  little or a few queries a lot, and at these sample sizes a 0.01 difference can be noise —
  so every comparison also reports wins/losses and a sign-test z (|z| > 2 is beyond noise).

Labeled corpora convert their labels to one format (`labels/queries.jsonl` + `test.tsv`,
read by `benchmark/lib/labels.mjs`):

- **nfcorpus** — BEIR NFCorpus: 3,633 medical abstracts, 323 queries, graded qrels
  (~38 judged/query). No links, so fused equals bm25-only; it measures lexical recall and
  the vocabulary gap semantic expansion targets.
- **fever** — FEVER dev split: 2,860 Wikipedia pages cited as evidence by 13,229 verifiable
  claims, with sentence link annotations kept as wikilinks. The claims are the queries; the
  corpus that can measure whether link fusion helps or hurts ranking.

Results (Apple Silicon, Node 26.7.0, 2026-08-13, 0.6.0):

| metric | nfcorpus bm25 | nfcorpus fused | nfcorpus semantic | fever bm25 | fever fused | fever semantic |
|---|---|---|---|---|---|---|
| nDCG@10 | 0.3233 | 0.3233 | 0.3444 | 0.9436 | 0.9361 | 0.9435 |
| MRR@10 | 0.5185 | 0.5185 | 0.5634 | 0.9508 | 0.9381 | 0.9479 |
| hit@10 | 0.6873 | 0.6873 | 0.7152 | 0.9969 | 0.9971 | 0.9974 |
| mean ms/query | 3.6 | 3.6 | 12.1 | 7.7 | 15.3 | 18.9 |

Paired deltas: on nfcorpus, semantic vs fused is 110W/77L on nDCG (z=2.4) and 16W/7L on hit
(z=1.9). On fever, semantic vs fused is 1084W/687L on nDCG (z=9.4).

Read:

- The published BEIR BM25 (Anserini) baseline for NFCorpus is nDCG@10 ≈ 0.32 — the FTS5
  pipeline matches it, so `find`'s lexical layer is a faithful BM25 rather than an
  approximation, and the identical fused column confirms link fusion is a no-op where there
  are no links.
- **The two corpora are the ends of one axis**, and no customer tree is either: NFCorpus is
  maximal vocabulary gap (layman queries, jargon documents — 31% of queries have no relevant
  document in the top 10), FEVER is zero gap (claims quote their evidence nearly verbatim,
  99.7% hit@10 for plain BM25). A change that wins on one by losing on the other is fitted to
  a corpus nobody has; see plans/fusion-tuning.md.
- **Semantic expansion earns its cost where the gap is real** and does no harm where it
  isn't: +0.021 nDCG / +0.028 hit on NFCorpus, and on FEVER it recovers most of link
  fusion's ranking cost rather than adding noise (0.9361 → 0.9435 nDCG).
- **Link fusion's own contribution is smaller than the fused column suggests.** Its score
  comes largely from PageRank restart mass sitting on the seed set, which re-ranks matches
  in near-match order; on FEVER it costs ~1 point of MRR by occasionally promoting neighbors
  above the true evidence page. Removing that restart mass was measured and rejected — it
  drops FEVER hit@10 to 0.907. `via` labels are gated on a real incident edge, so the labels
  stay honest even where the score echo remains.

### Static-model bake-off (semantic-search-design.md, sequence step 2)

`benchmark/bakeoff.mjs <corpus>` embeds a labeled corpus with the candidate static model,
scores cosine-only and bm25+vector RRF (find's pool size and RRF constant) against the
qrels, and prints each storage lever next to the acceptance thresholds. Model files
fetch once into `.tmp/cache/`, pinned by revision like corpora. Doc vectors are stored
per lever (sliced, re-normalized, optionally int8); queries stay f32.

Results — nfcorpus, 323 queries, `minishlab/potion-retrieval-32M@6fc8051f`
(macOS arm64, Node 26, 2026-08-13). Model load 39 ms, embed 0.30 ms/doc:

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

- The acceptance thresholds below were the bar for silent default-on fusion, superseded
  2026-08-13 by the explicit-expansion reframe (plans/semantic-search-design.md, "Gate and
  acceptance"): the bar is now recall-when-invoked, which these numbers clear at every lever.
- **Fusion helps at every lever** — both nDCG and hit improve across the board — but
  **no lever clears both acceptance thresholds** (ΔnDCG ≥ +0.02 and Δhit ≥ +0.03):
  512-dim clears nDCG and misses hit by 0.008; 128-dim clears hit and misses nDCG;
  256-dim near-misses both. Latency passes everywhere (≤1.9 ms vs the 10 ms ceiling).
- **int8 storage is free**: identical quality to f32 at every dims setting, at ¼ the
  bytes. Whatever ships, vectors store quantized.
- **Cosine-only never beats BM25** (0.309 vs 0.323 at best) — consistent with published
  results on this BM25-favoring dataset, so the pure-JS loader is faithful; and it
  confirms the design's recall-layer stance: vectors must fuse, never replace.
- The fusion here is untuned equal-weight RRF at pool 30. NFCorpus ships train/dev
  qrels (`labels/dev.tsv`, readable via `readLabels(dir, 'dev')`), so fusion-tuning
  levers can be tuned on dev and reported on test without touching the gate.

## Capabilities

| | 0.2.1 | 0.3.0 | 0.6.0 | 0.7.2 | local |
|---|---|---|---|---|---|
| frontmatter filter + FTS5 search | ✓ | ✓ | ✓ | ✓ | ✓ |
| links table, backlinks, dead links | — | ✓ | ✓ | ✓ | ✓ |
| sections table, outline with line ranges | — | ✓ | ✓ | ✓ | ✓ |
| PageRank (`_rank`), hub detection | — | ✓ | ✓ | ✓ | ✓ |
| fused retrieval (`find`, `via` column) | — | ✓ | ✓ | ✓ | ✓ |
| bounded orient/structure commands (`map`, `peek`) | — | ✓ | ✓ | ✓ | ✓ |
| lenient frontmatter (syntax errors → warnings, values kept) | — | ✓ | ✓ | ✓ | ✓ |
| config auto-migration | — | ✓ | ✓ | ✓ | ✓ |
| feature toggles | — | ✓ | ✓ | ✓ | ✓ |
| `--version` | — | ✓ | ✓ | ✓ | ✓ |
| semantic expansion (`features.embed`, `find --semantic`, `via: vector`) | — | — | ✓ | ✓ | ✓ |
| feature state reported by `map` and `status` | — | — | ✓ | ✓ | ✓ |
| labeled-corpus retrieval eval (nDCG/MRR/hit, paired deltas) | — | — | ✓ | ✓ | ✓ |
| saved-query assertions (`sense check`, `checks`) | — | — | — | ✓ | ✓ |
| tree-declared find scope (`defaults.find.where`) | — | — | — | ✓ | ✓ |
| `similarity` on semantic rows | — | — | — | ✓ | ✓ |
| scale corpora (13k / 26k) measured per release | — | — | — | ✓ | ✓ |
| saved finds (`queries` object form, `sense <name>` with baked-in settings) | — | — | — | — | ✓ |
| bounded excerpts + `lines` on every `find` row | — | — | — | — | ✓ |
| incremental link resolution; PageRank only on edge changes | — | — | — | — | ✓ |
| derived `busy_timeout` (from observed reconcile, in `status`) | — | — | — | — | ✓ |
| progress on stderr for long builds (TTY-aware, sparse when piped) | — | — | — | — | ✓ |
| column-limit fence (named error at SQLite's 2,000) | — | — | — | — | ✓ |
| stress corpus in the release gate | — | — | — | — | ✓ |
