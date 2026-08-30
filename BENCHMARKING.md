# Benchmarks

Per-release measurements on a public corpus: methodology here, per-sitting numbers in
`benchmark/reports/` (one file per measurement sitting, YAML frontmatter for date/versions/
machine/corpora/models/headline metrics, so the tree is queryable), the current canonical
digits linked from "Numbers of record" below.

## Running

```bash
node benchmark/compare.mjs                             # released baseline (package.json) vs working tree
node benchmark/compare.mjs obsidian-hub 0.2.1 local    # explicit corpus and versions
node benchmark/eval.mjs nfcorpus                       # retrieval quality on a labeled corpus
node benchmark/bakeoff.mjs nfcorpus                     # storage-lever bake-off for one model
node benchmark/weight-sweep.mjs nfcorpus                # per-signal RRF weight sweep
node benchmark/oracle.mjs <corpus> <path>               # tags/links/chunk extents vs Obsidian's metadataCache
```

The default run answers "did the working tree regress?" `local` is whatever is checked out. The working-tree column is labeled `local` until the release exists: regenerate the table at release time and the column gets its real number. Named corpora, dataset builds, and npm-installed comparison versions all cache through `benchmark/lib/cache.mjs` into `.tmp/cache/` (gitignored): fetched once, built atomically in a staging dir, safe to delete anytime. Corpus specs are pinned in `benchmark/lib/corpus.mjs`, the single source of truth. A directory path works in place of a corpus name.

`compare.mjs` installs each npm version into a temp dir (`local` = this working tree), gives every version an isolated copy of the tree with a v1 config (the lowest common denominator every version can read; copies keep cache formats and config auto-migration from cross-contaminating), runs `benchmark/run.mjs` per version, and prints the table. `run.mjs` can also run alone against any single package root + tree; it prints one JSON row.

`bakeoff.mjs` and `weight-sweep.mjs` measure one specific model/dims/weight choice against a labeled corpus's qrels, decision-support for a config default, not a release gate. `oracle.mjs` is the correctness gate against Obsidian's own metadataCache (RELEASING.md step 3), needs Obsidian running, and stores nothing.

Two kinds of metric per version:

- **Wall-time:** spawns the CLI per operation, so every number includes ~40 ms of Node startup. This is what a calling agent pays per invocation. On embed-enabled trees `run.mjs` also times `search` with vectors (`semantic_find_ms`); its delta over `find_ms` is the per-invocation semantic cost: model load, query embed, vector scan (null on trees without embed).
- **In-process:** imports the version's `dist/esm/index.js` as a library and times the engine alone: cold index build, the no-change freshness check, and incremental updates (1 file touched, 10 files modified). Pure Node, no platform dependence.

## Maintaining

- Regenerate **all** columns of a table in one sitting on one machine. Numbers are not comparable across machines or Node versions. Record machine + Node in the report's frontmatter.
- Regenerate **before** the version bump, not after publishing: a benchmark run is only a release gate if a bad number can still stop the release. See [RELEASING.md](RELEASING.md).
- The performance tables regenerate every release; the retrieval-quality tables regenerate when retrieval itself changes: fusion, ranking, the default model, tokenizer, chunking. A quality report older than the current version is expected, and says the ranking has not moved since; a retrieval change shipped without a fresh report is the gap to catch.
- To add a metric: one measured field in `run.mjs`, one row in the `ROWS` table in `compare.mjs`. Versions lacking a command report `—` automatically; a version that errors reports the error.
- Corpus pins live in `benchmark/lib/corpus.mjs`. If a pin must move (repo disappears, need a bigger corpus), regenerate every column at the new pin.
- Each sitting is a new file in `benchmark/reports/`, never an edit to a previous one, and the previous terminal report is deleted when the new one lands: the directory holds the current terminal report and the thematic reports, git is the history. Update "Numbers of record" below to point at it. Add a "Methodology changelog" entry only when the change is about HOW something is measured (a new guard, a new corpus, a harness bug fix, a discipline rule); a numbers-only regeneration gets a report file and nothing else.

## Interpreting

- Timings are medians (wall: 5 runs, cold crawl 1; in-process: 5 no-change, 3 updates).
- Wall minus in-process ≈ per-invocation overhead: process spawn, Node/V8 startup, importing sense and its dependencies, argv parsing. The two move independently. If the in-process number grows, the engine (scan/reconcile/SQL) got slower; if the gap grows while in-process stays flat, startup got heavier, typically a new dependency imported at module top level, which every invocation pays for before any work happens. Commands lazy-load from `src/cli/` (cli.ts imports no tree code), so a heavy import belongs inside the one command that uses it; `--version` is the canary: it should stay at bare Node startup (~25 ms here).
- The update rows include everything reconcile does after re-parsing: link re-resolution across the whole table and a full PageRank pass. They are the numbers to watch as features add reconcile work.
- The bulk-change pair measures `watch`: without a watcher, the first query after many files change pays the whole reparse; with one running, the reparse happened in the background and the query pays only the freshness check.
- Token columns (`map`, `peek`, `search` row) are output-size contracts, not performance: they must stay roughly flat as trees grow. A token number that scales with tree size is a context-bloat regression even if timings look fine. The `search` row is measured in json, per row actually returned, and tracks summary and snippet length rather than tree size.
- Watch for: cold build growing worse than linearly with note count; the no-change check drifting above ~50 ms at 10k notes; the update rows drifting away from the freshness check they now track (update minus no-change is the real update work; it should stay in the tens of ms); any stress-table row moving (each guards a fixed shape cliff).

## Scale

The README claims linear scaling and links here rather than carrying figures of its own. `obsidian-hub-x2` and `obsidian-hub-x4` (13k / 26k notes) are named corpora that replicate the pinned hub tree N times under one root: real notes, real frontmatter, real links, regenerated from nothing like every corpus. Duplicate basenames across copies stress link-ambiguity resolution harder than a natural tree. Run `node benchmark/run.mjs . <corpusPath>` per tree; regenerate scale rows together with the main table, in the same report file.

Cold-crawl wall numbers move with file-cache state: the first pass of the day reads high, so only a same-sitting, same-cache version A/B is a meaningful comparison for that row, confirmed more than once across sittings (see the reports).

What the scale rows watch, in order of what actually breaks: the per-query freshness check (stats every file, linear, the cost every call pays), cold crawl (linear; a quadratic here was found and fixed at 13k/26k. FTS5 DELETE by column scanned the whole table, and delete-before-insert ran per doc on cold builds where the table was empty), reconcile after updates (linear; dominated by whole-table link re-resolution plus a full PageRank pass), and the watcher race (a query during the watcher's bulk write transaction waits on `busy_timeout`, sized at 30s to cover ~3x the largest measured reconcile).

Current numbers: see "Numbers of record" below.

## Stress: the shape-cliff guard

`stress` is a pinned synthetic corpus (benchmark/lib/corpus.mjs) that packs every measured shape cliff into one 2,000-note tree: a 1 MB note, 200 headings per note, 100 links per note, 300 distinct frontmatter fields. Each cliff was found by the shape sweep (`benchmark/sweep.mjs`), fixed, and is held fixed by this row per release: `node benchmark/run.mjs . .tmp/cache/stress-stress-1`.

The sweep itself (`sweep.mjs`) re-runs when the engine changes, not per release; the probes it keeps (SQLite's 2,000-column limit fenced with a named error, adversarial markdown at ~8 s / 5 pathological notes with no timeout) are recorded in the findings file.

Current numbers: see "Numbers of record" below.

## Retrieval quality

`benchmark/eval.mjs <corpus>` runs every labeled query through the shipped library in four passes and reports nDCG@10, MRR@10 and hit@10 against the corpus qrels: **bm25-only** (links and rank off), **fused** (BM25 + link expansion), **fused-embed-configured** (the embed block present, the preset's `signals` without `vectors`; a hidden guard pass), and **semantic** (embed block present, `vectors` in the preset's `signals`). There is no per-call semantic switch: the preset decides, so the guard exercises the one lever a tree owner actually has. Queries are natural-language text submitted as an OR bag of words (the standard bag-of-words baseline; bare FTS5 terms AND-join and punctuation is syntax).

Two guards run before any number is reported:

- **Bit-identity.** The guard pass must return rows identical to fused, query for query; a divergence aborts the run with a nonzero exit. This is what makes "a vectors-free preset changes nothing on an embed-configured tree" a tested claim rather than a design intention.
- **Paired per-query deltas.** Point metrics hide whether a change moved many queries a little or a few queries a lot, and at these sample sizes a 0.01 difference can be noise. Every comparison also reports wins/losses and a sign-test z (|z| > 2 is beyond noise).

Labeled corpora convert their labels to one format (`labels/queries.jsonl` + `test.tsv`, read by `benchmark/lib/labels.mjs`):

- **nfcorpus:** BEIR NFCorpus, 3,633 medical abstracts, 323 queries, graded qrels (~38 judged/query). No links, so fused equals bm25-only; it measures lexical recall and the vocabulary gap semantic expansion targets.
- **fever:** FEVER dev split, 2,860 Wikipedia pages cited as evidence by 13,229 verifiable claims, with sentence link annotations kept as wikilinks. The claims are the queries; the corpus that can measure whether link fusion helps or hurts ranking.
- **miracl-\<lang\>:** per-language MIRACL (`benchmark/lib/corpus.mjs`'s `miracl` builder), judged docs as a floor plus reservoir-sampled distractors toward ~3-5k docs. The multilingual counterpart to nfcorpus/fever's English-only pair; CJK-script queries need `orBag`'s unigram split (see the methodology changelog) or they score at chance level.

Storage-lever and fusion-weight choices (dims, int8 vs f32, per-signal RRF weight) are measured against these same corpora by `bakeoff.mjs` and `weight-sweep.mjs`. Read: the published BEIR BM25 (Anserini) baseline for NFCorpus is nDCG@10 ≈ 0.32, which the FTS5 pipeline matches, so `search`'s lexical layer is a faithful BM25 rather than an approximation. NFCorpus and FEVER are the ends of one vocabulary-gap axis (NFCorpus: layman queries over jargon documents, 31% of queries have no relevant document in the top 10; FEVER: claims quote their evidence nearly verbatim, 99.7% hit@10 for plain BM25), and no customer tree sits at either end. A change that wins on one by losing on the other is fitted to a corpus nobody has.

Current numbers: see "Numbers of record" below.

## The chunking algorithm

The unit sense embeds is a block from an `mdast`-parsed tree, not a raw text slice. Headings
are hard boundaries: a chunk never spans one, and a heading is never orphaned from the
content under it. Inside a section, consecutive paragraphs pair up, capped by the
2×workingSize invariant (workingSize defaults to 500 estimated tokens; `embed.chunkTokens`
lowers it for a small-context model). A line too long to fit alone splits line -> sentence ->
word, sentences and words found via `Intl.Segmenter` (ECMA-402), the only way an unbroken
CJK line becomes splittable at all. Code fences, tables, and list groups are atomic: parsed
as typed nodes, they are never cut internally. Every chunk carries the note's title and
summary as a prefix, and the text is embedded raw, markdown syntax included, with no
stripping transform (measured, not assumed: benchmark/reports/2026-08-27-chunking-sweep-w4.md).

Evidence behind the design:

- [A Systematic Investigation of Document Chunking Strategies and Embedding Sensitivity](https://arxiv.org/html/2603.06976): 36 strategies × 6 domains × 5 embedding models; paragraph-group chunking (PGC) wins, and the ranking is stable across embedding models.
- [Chunking Methods on Retrieval-Augmented Generation: Effectiveness Evaluation Against Computational Cost and Limitations](https://arxiv.org/html/2606.00881v1): recursive splitting beats fixed-size, graph-based, and LLM-boundary methods, at a fraction of the cost.
- [Evaluating Chunking Strategies for Retrieval-Augmented Generation on Academic Texts](https://arxiv.org/html/2607.01852v1): simple recursive and fixed-size splitting beat semantic clustering; simpler chunking strategies were overall more reliable.
- [Rethinking Chunk Size for Long-Document Retrieval: A Multi-Dataset Analysis](https://arxiv.org/html/2505.21700v2): chunk size should follow the shape of the expected answer: small for concise facts, large for dispersed ones.

## Methodology changelog

Dated entries record a change to HOW something is measured, not a numbers-only regeneration
(those live in `benchmark/reports/` alone). Reconstructed from `git log --follow -p --
BENCHMARKING.md` (20 commits, 2026-08-12 through 2026-08-28) and the harness scripts' own
history; each entry names the commit that introduced the change.

- **2026-08-13, `566c86a`.** `eval.mjs` gains its four-pass structure (bm25-only / fused /
  embed-on / semantic, later renamed fused-embed-configured), the bit-identity guard (the
  guard pass must return rows identical to fused, query for query), and paired per-query
  deltas (wins/losses plus a sign-test z, |z| > 2 read as beyond noise), up from an
  original two-pass bm25-only/fused design with no guard. First table under this scheme:
  the 0.6.0 sitting (benchmark/reports/2026-08-13-0.6.0-release-gate.md).
- **2026-08-13, `6818180`.** "Regenerate before the version bump, not after publishing"
  enters the Maintaining section: a benchmark run is only a release gate if a bad number can
  still stop the release. Still the rule RELEASING.md step 2 encodes.
- **2026-08-13 (silent-fusion thresholds retired).** The static bake-off's acceptance
  thresholds (ΔnDCG >= +0.02, Δhit >= +0.03) were the bar for turning fusion on by default.
  The explicit-embed reframe removed silent default-on fusion, so the question became "how
  much does this lever recover once a tree owner opts in", not "is it safe to default on" --
  the same bake-off tables are still measured, read differently.
- **2026-08-15, `45b6d97`.** The `stress` shape-cliff corpus enters the release gate for the
  first time. The Maintaining section gains the still-current cadence rule: performance
  tables regenerate every release, retrieval-quality tables regenerate when retrieval itself
  changes. Token-contract language broadens from `map`/`peek` to include the `find`/`search`
  row (excerpt length as a size contract, not a timing).
- **2026-08-16, `07db150`.** Config v3 (presets) ships with vectors on by default, which
  changes what every subsequent sitting measures unconditionally: cold crawl now always pays
  per-chunk placeholder-row bookkeeping, and the Scale table gains a `semantic search (steady
  state)` row at every corpus size rather than omitting it when no preset had vectors on.
  Also establishes by example the still-standing discipline of catching a quadratic before
  release rather than shipping and finding it later (`preset_files` deletes scanning the
  whole table per doc, fixed the same sitting).
- **2026-08-21, `824fa2e`.** Establishes "a contract movement found by the gate gets fixed,
  not recorded as an accepted regression" by example: `peek`'s token growth (+26%, a 2-hop
  section) is removed rather than accepted, and `related`'s cost gets a seed-chunk sampling
  cap (16) rather than being logged as a known-slow row. Separately: `fast-glob` is replaced
  with `node:fs` `globSync` (removes 15 transitive dependencies, costs ~2.2x glob time), the first explicit dependency-vs-measured-speed trade recorded and knowingly accepted here.
- **2026-08-21, `cf901fd`.** The harness-warmup caveat is found and documented for the first
  time: `compare.mjs`'s first-version-benchmarked pays a large one-time machine warmup (the
  baseline's `npm install` is itself the warmup), which can read 4-5x slower on every row.
  Confirmed by reversing column order and re-running; a reversed-column-order confirmation
  run is the standing remedy for a suspicious delta from here on, still cited in the current
  numbers-of-record report.
- **2026-08-22, `7ecc55a`.** The nfcorpus and fever retrieval-quality tables split from one
  combined table into two per-corpus tables (still the current shape). The guard pass is
  renamed "fused-embed-configured", and the standing Scale caveat "cold-crawl wall numbers
  move with file-cache state" is documented for the first time. Two eval-harness bugs are
  found and fixed this sitting (after the explicit-embed change, eval's embed variants
  stopped naming a model, so the semantic pass silently measured lexical; eval also still
  passed a per-call `semantic` option the library had removed, so the guard pass measured
  nothing, the two bugs masked each other). Produces the still-standing rule: eval columns
  regenerate whenever eval.mjs or the config semantics it drives change, not only when
  ranking does.
- **2026-08-23, `25e0e0f`.** An Obsidian metadataCache parity gate (`benchmark/oracle.mjs`)
  is added as RELEASING.md step 3: diffs sense's tags/links (later extended to section/block
  extents) against Obsidian's own metadataCache on both the hub corpus and a real vault. A
  correctness-gate discipline layered on top of the performance/quality gates: a release can
  be flat and still fail this gate.
- **2026-08-23, `2c2e9fb`.** The release-gate table's baseline column is explicitly re-pinned
  with the caption stating why and which intervening releases went ungated, rather than
  silently dropping the gap, the discipline this doc's Results/numbers-of-record captions
  still follow.
- **2026-08-27, `451d44d`.** Two new harness scripts land: `bakeoff.mjs` gets a fixed bug
  where a storage lever wider than a model's native dims silently read past the vector into
  `NaN`-scored garbage instead of erroring (levers are now capped to native dims), and
  `weight-sweep.mjs` (per-preset signal-weight sweep) is added as a new measured axis. Weight 1 reproduces every pre-existing eval number digit-for-digit, so this is additive,
  not a rebase of prior tables. The MIRACL per-language corpus builder lands (judged docs as
  an unconditional floor, distractors padding toward a ~3-5k target only when short of it).
  `benchmark/lib/labels.mjs`'s `orBag` is found to assume word-spaced script (a CJK passage
  merges into one near-unmatchable token, chance-level BM25 pre-fix); fixed by splitting
  CJK-script runs to one-character unigrams (Lucene's `StandardTokenizer` convention). Any
  future non-space-delimited script needs the same check before its numbers are trusted.
- **2026-08-27 (W4 chunking sweep).** A formal decision rule for shipping a measured variant
  is stated for the first time: per corpus, never averaged; ship the candidate that loses on
  no corpus, simplest among those; flat everywhere ships the simplest on the correctness
  argument. This rule, not a blended score, is what closes a grouping/chunking decision.
  A harness gap is found and flagged, not fixed, in the same sweep: the chunk cache's feature
  signature (`chunk:v2`) did not vary with grouping options, so re-running eval.mjs after only
  editing `chunk()`'s options silently reused stale cached chunks; every sweep run cleared
  `.sense` by hand to work around it. Closed properly later by W3b/W7's option-aware signature
  (`chunk:v2:<n>`, then `chunk:v4`).
- **2026-08-28 (W8 release-gate regeneration).** A cache-rebuild sanity check is formalized:
  after a schema-version bump, the gate verifies that a tree cached under the old schema
  opens with a real "cache format changed; rebuilding the index" notice as the first line of
  its run, rather than trusting that the version constant changed without observing the
  rebuild fire against real prior cache state.

## Numbers of record

The canonical digits a release gate compares against, each linking to the report that
produced it. When a number here moves, replace the value and the link together.

| metric | value | report |
|---|---|---|
| cold crawl, obsidian-hub (wall, local) | 2540 ms | [2026-08-30](benchmark/reports/2026-08-30-0.19.0-release-gate.md) |
| warm query (`COUNT(*)`) | 134 ms | [2026-08-30](benchmark/reports/2026-08-30-0.19.0-release-gate.md) |
| lexical `search` | 181 ms | [2026-08-30](benchmark/reports/2026-08-30-0.19.0-release-gate.md) |
| `search` row size | ~71 tokens | [2026-08-29](benchmark/reports/2026-08-29-0.18.0-release-gate.md) |
| `map` | 174 ms / ~496 tokens | [2026-08-30](benchmark/reports/2026-08-30-0.19.0-release-gate.md) |
| `peek` largest note | 153 ms / ~581 tokens | [2026-08-30](benchmark/reports/2026-08-30-0.19.0-release-gate.md) |
| in-process: cold index build | 2210 ms | [2026-08-30](benchmark/reports/2026-08-30-0.19.0-release-gate.md) |
| in-process: freshness check, no change | 37.1 ms | [2026-08-30](benchmark/reports/2026-08-30-0.19.0-release-gate.md) |
| `--version` canary | 20 ms | [2026-08-29](benchmark/reports/2026-08-29-0.18.0-release-gate.md) |
| scale, 13k: cold crawl (wall) | 5.02 s | [2026-08-30](benchmark/reports/2026-08-30-0.19.0-release-gate.md) |
| scale, 26k: cold crawl (wall) | 10.02 s | [2026-08-30](benchmark/reports/2026-08-30-0.19.0-release-gate.md) |
| stress: lexical `search` | 350 ms | [2026-08-30](benchmark/reports/2026-08-30-0.19.0-release-gate.md) |
| stress: semantic `search` | 980 ms | [2026-08-30](benchmark/reports/2026-08-30-0.19.0-release-gate.md) |
| nfcorpus semantic nDCG@10 / hit@10 | 0.3427 / 0.7121 | [2026-08-29](benchmark/reports/2026-08-29-0.18.0-release-gate.md) |
| fever semantic nDCG@10 / hit@10 | 0.9337 / 0.9965 | [2026-08-29](benchmark/reports/2026-08-29-0.18.0-release-gate.md) |
| chunker grouping (D3/D4/D9) | pgc, no overlap, raw text | [2026-08-27 chunking sweep (W4)](benchmark/reports/2026-08-27-chunking-sweep-w4.md) |
| default static model | `minishlab/potion-retrieval-32M` | [2026-08-27 embedding model selection](benchmark/reports/2026-08-27-embedding-model-selection.md) |
| storage lever | int8 @ 256 dims | [2026-08-13 static-model bake-off](benchmark/reports/2026-08-13-static-model-bakeoff.md) |
