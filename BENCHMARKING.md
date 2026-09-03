# Benchmarks

Per-release measurements on a public corpus: methodology here, per-sitting numbers in
`benchmark/reports/` (one file per measurement sitting, YAML frontmatter for date/versions/
machine/corpora/models/headline metrics, so the tree is queryable), the current canonical
digits linked from "Numbers of record" below.

## Running

The gate is one command. Everything under it is reachable alone, and the directory says which is
which: `benchmark/gate.mjs` is the entry, `benchmark/steps/` is what the gate runs, and
`benchmark/tools/` is decision support that is never part of a release.

```bash
npm run benchmark                     # the gate: the stages the diff owes, a report, a verdict
npm run benchmark -- --dry-run        # what it would run, measuring nothing
node benchmark/report.mjs             # re-render a report from its sitting, measuring nothing
```

The steps, each runnable alone when investigating one thing:

```bash
node benchmark/steps/measure-tree.mjs . <notes-dir|corpus>          # one package against one tree; the JSON row everything else reads
node benchmark/steps/compare-versions.mjs                           # released baseline (package.json) vs working tree
node benchmark/steps/compare-versions.mjs obsidian-hub 0.2.1 local  # explicit corpus and versions
node benchmark/steps/quality.mjs nfcorpus                           # retrieval quality on a labeled corpus
node benchmark/steps/oracle.mjs <corpus> <path>                     # tags/links/chunk extents vs Obsidian's metadataCache
node benchmark/steps/store-dump.mjs capture <dir>                   # every store's rows and ranked output, for an A/B against a refactor
node benchmark/steps/store-dump.mjs compare <dirA> <dirB>           # diffs two captures, non-zero on any difference
```

The tools, for settling a decision rather than gating a release:

```bash
node benchmark/tools/bakeoff.mjs nfcorpus       # storage-lever bake-off for one model
node benchmark/tools/weight-sweep.mjs nfcorpus  # per-signal RRF weight sweep
node benchmark/tools/sweep.mjs                  # the shape sweep behind the stress corpus
node benchmark/tools/profile.mjs                # cold build by stage
```

A run resumes by default. The sitting is keyed on the tree it measures, so an interrupted run picks up where it stopped and editing code starts a fresh one; delete the directory the run prints for a clean start. One store or one tree alone is `measure-tree.mjs`, below.

The default run answers "did the working tree regress?" `local` is whatever is checked out. The working-tree column is labeled `local` until the release exists: regenerate the table at release time and the column gets its real number. Named corpora, dataset builds, and npm-installed comparison versions all cache through `benchmark/lib/cache.mjs` into `.tmp/cache/` (gitignored): fetched once, built atomically in a staging dir, safe to delete anytime. Corpus specs are pinned in `benchmark/lib/corpus.mjs`, the single source of truth. A directory path works in place of a corpus name.

`compare-versions.mjs` installs each npm version into a temp dir (`local` = this working tree), gives every version an isolated copy of the tree with a v1 config (the lowest common denominator every version can read; copies keep cache formats and config auto-migration from cross-contaminating), runs `benchmark/steps/measure-tree.mjs` per version, and prints the table. `measure-tree.mjs` can also run alone against any single package root + tree; it prints one JSON row.

`bakeoff.mjs` and `weight-sweep.mjs` measure one specific model/dims/weight choice against a labeled corpus's qrels, decision-support for a config default, not a release gate. `oracle.mjs` is the correctness gate against Obsidian's own metadataCache; the gate runs it, opening the vault itself, and it stores nothing.

`store-dump.mjs` is the refactor gate for anything touching the write path: capture before a change,
capture after, compare. It records two things per store and both halves are required. Every logical
table's rows in primary-key order, and the ordered results of a fixed query set with their scores.
The ranking half is not redundant: a lexical index lives outside the logical tables, so dumps compare
identical while search is silently unranked. Turso answers correctly with its FTS index dropped,
since `fts_match` falls back to a scan, and only `fts_score` collapses to 0. A clean compare names
every file it checked rather than passing in silence.

Two kinds of metric per version:

- **Wall-time:** spawns the CLI per operation, so every number includes ~40 ms of Node startup. This is what a calling agent pays per invocation. On embed-enabled trees `measure-tree.mjs` also times `search` with vectors (`semantic_find_ms`); its delta over `find_ms` is the per-invocation semantic cost: model load, query embed, vector scan (null on trees without embed).
- **In-process:** imports the version's `dist/esm/index.js` as a library and times the engine alone: cold index build, the no-change freshness check, and incremental updates (1 file touched, 10 files modified). Pure Node, no platform dependence.

## Maintaining

- Regenerate **all** columns of a table in one sitting on one machine. Numbers are not comparable across machines or Node versions. Record machine + Node in the report's frontmatter.
- Regenerate **before** the version bump, not after publishing: a benchmark run is only a release gate if a bad number can still stop the release. See [RELEASING.md](RELEASING.md).
- The performance tables regenerate every release; the retrieval-quality tables regenerate when retrieval itself changes: fusion, ranking, the default model, tokenizer, chunking. A quality report older than the current version is expected, and says the ranking has not moved since; a retrieval change shipped without a fresh report is the gap to catch.
- To add a metric: one measured field in `measure-tree.mjs` and one row in `benchmark/lib/rows.mjs`, the single catalog every table and frontmatter key derives from. Versions lacking a command report `—` automatically; a version that errors records the error against the row.
- Corpus pins live in `benchmark/lib/corpus.mjs`. If a pin must move (repo disappears, need a bigger corpus), regenerate every column at the new pin.
- Each sitting is a new file in `benchmark/reports/`, never an edit to a previous one, and nothing is deleted: the gate resolves a row's prior from the newest earlier report that ran that step, so the history is what makes a comparison possible. "Numbers of record" below is repointed by `report.mjs` on a PASS, never by hand. Add a "Methodology changelog" entry only when the change is about HOW something is measured (a new guard, a new corpus, a harness bug fix, a discipline rule); a numbers-only regeneration gets a report file and nothing else.

### Adding a check

One rule: **a check goes in the earliest stage whose failure it can cause cheaply.** `benchmark/lib/stages.mjs` lists the stages in order and is the one obvious place a new step goes.

| the check | stage | what it is |
|---|---|---|
| correctness or parity | 1 functional | a test, or a gate script with `--out` |
| a contract or shape on the hub corpus | 2 baseline | a catalog row with `kind: 'tokens'`, or a band |
| a scaling or shape cliff | 3 scale | a row measured at 13k, 26k or stress |
| retrieval quality | 4 quality | a metric in `steps/quality.mjs` and a catalog row |

A measured step needs one entry in `stages.mjs` plus one row in `benchmark/lib/rows.mjs`. The harness test asserts every step id has a catalog row or is a functional gate, and that a real `measure-tree.mjs` row carries exactly the catalog's keys.

## Interpreting

- Timings are medians. Wall: 5 runs, cold crawl 3, bulk change 3, bulk change with a warm watcher 3. In-process: 5 no-change, 3 updates, cold build 3. Cold crawl, in-process cold build and both bulk-change rows stepped down from a single sample to a median of 3 on 2026-09-01 (see the methodology changelog); every other row was already a median.
- Wall minus in-process ≈ per-invocation overhead: process spawn, Node/V8 startup, importing sense and its dependencies, argv parsing. The two move independently. If the in-process number grows, the engine (scan/reconcile/SQL) got slower; if the gap grows while in-process stays flat, startup got heavier, typically a new dependency imported at module top level, which every invocation pays for before any work happens. Commands lazy-load from `src/cli/` (cli.ts imports no tree code), so a heavy import belongs inside the one command that uses it. `version_canary_ms` is the bare-startup floor, a median of 5 `--version` spawns, and it is answered before any command loads: it cannot see import creep behind a command, which is what the wall-minus-in-process gap above is for (PLAN.md 3.11).
- The update rows include everything reconcile does after re-parsing: link re-resolution across the whole table and a full PageRank pass. They are the numbers to watch as features add reconcile work.
- The bulk-change pair measures `watch`: without a watcher, the first query after many files change pays the whole reparse; with one running, the reparse happened in the background and the query pays only the freshness check.
- Token columns (`map`, `peek`, `search` row) are output-size contracts, not performance: they must stay roughly flat as trees grow. A token number that scales with tree size is a context-bloat regression even if timings look fine. The `search` row is measured in json, per row actually returned, and tracks summary and snippet length rather than tree size.
- Watch for: cold build growing worse than linearly with note count; the no-change check drifting above ~50 ms at 10k notes; the update rows drifting away from the freshness check they now track (update minus no-change is the real update work; it should stay in the tens of ms); any stress-table row moving (each guards a fixed shape cliff).

## Scale

The README claims linear scaling and links here rather than carrying figures of its own. `obsidian-hub-x2` and `obsidian-hub-x4` (13k / 26k notes) are named corpora that replicate the pinned hub tree N times under one root: real notes, real frontmatter, real links, regenerated from nothing like every corpus. Duplicate basenames across copies stress link-ambiguity resolution harder than a natural tree. Run `node benchmark/steps/measure-tree.mjs . <corpusPath>` per tree; regenerate scale rows together with the main table, in the same report file.

Cold-crawl wall numbers move with file-cache state: the first pass of the day reads high, so only a same-sitting, same-cache version A/B is a meaningful comparison for that row, confirmed more than once across sittings (see the reports).

What the scale rows watch, in order of what actually breaks: the per-query freshness check (stats every file, linear, the cost every call pays), cold crawl (linear; a quadratic here was found and fixed at 13k/26k. FTS5 DELETE by column scanned the whole table, and delete-before-insert ran per doc on cold builds where the table was empty), reconcile after updates (linear; dominated by whole-table link re-resolution plus a full PageRank pass), and the watcher race (a query during the watcher's bulk write transaction waits on `busy_timeout`, sized at 30s to cover ~3x the largest measured reconcile).

Current numbers: see "Numbers of record" below.

## Stress: the shape-cliff guard

`stress` is a pinned synthetic corpus (benchmark/lib/corpus.mjs) that packs every measured shape cliff into one 2,000-note tree: a 1 MB note, 200 headings per note, 100 links per note, 300 distinct frontmatter fields. Each cliff was found by the shape sweep (`benchmark/tools/sweep.mjs`), fixed, and is held fixed by this row per release: `node benchmark/steps/measure-tree.mjs . .tmp/cache/stress-stress-1`.

The sweep itself (`sweep.mjs`) re-runs when the engine changes, not per release; the probes it keeps (SQLite's 2,000-column limit fenced with a named error, adversarial markdown at ~8 s / 5 pathological notes with no timeout) are recorded in the findings file.

Current numbers: see "Numbers of record" below.

## Retrieval quality

`benchmark/steps/quality.mjs <corpus>` runs every labeled query through the shipped library in four passes and reports nDCG@10, MRR@10 and hit@10 against the corpus qrels: **bm25-only** (links and rank off), **fused** (BM25 + link expansion), **fused-embed-configured** (the embed block present, the preset's `signals` without `vectors`; a hidden guard pass), and **semantic** (embed block present, `vectors` in the preset's `signals`). There is no per-call semantic switch: the preset decides, so the guard exercises the one lever a tree owner actually has. Queries are natural-language text submitted as an OR bag of words (the standard bag-of-words baseline; bare FTS5 terms AND-join and punctuation is syntax).

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
- **2026-08-23, `25e0e0f`.** An Obsidian metadataCache parity gate (`benchmark/steps/oracle.mjs`)
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
- **2026-08-30 (0.20.0 release gate).** `store-dump.mjs` grows from two scenarios
  (cold, incremental) to six, adding four reopen scenarios (warm, schema-bump,
  signature, embed-identity) that also capture the store's stderr notices, because
  several `open()` branches (full rebuild versus in-place adoption) end at identical
  tables by different routes and the notice is the only observable that tells them
  apart. `embed-identity` exists to make 0.20.0's in-place identity adoption visible
  against 0.19.2's clear-and-re-embed path on duckdb and turso.
- **2026-09-01 (staged release gate).** `cold_crawl_ms`, in-process `cold_build_ms`,
  `bulk_change_ms` and `bulk_watch_ms` step down from one sample to a median of 3, clearing
  `.sense` (cold rows) or re-touching (bulk rows) before each rep, same shape as the 2026-08-23
  re-pin's "regenerate every column together" discipline: the sample list travels beside the
  median in `run.mjs`'s JSON row rather than replacing it. A catalog (`benchmark/lib/rows.mjs`)
  becomes the single vocabulary for every field `run.mjs` and `eval.mjs` emit, a pure classifier
  (`benchmark/lib/classify.mjs`) turns a prior/current reading into `flat`/`noise`/`moved`/
  `contract`/`fell`/`no-prior`, and `release.mjs` prints a generated `PASS`/`BLOCK` verdict from
  it instead of a "paste these tables in" instruction. `run.mjs` gains `version_canary_ms` (five
  `--version` spawns, median), the row the numbers of record already carried with nothing
  measuring it. `benchmark/report.mjs` renders `benchmark/reports/<date>-release-gate.{json,md}`
  from a sitting and is the only writer of the numbers-of-record table below: a `PASS` sitting
  repoints it, a `BLOCK` sitting leaves it untouched, and `report.mjs --accept <row id> --reason
  "<words>"` is the sole owner override.

- **2026-09-02 (staged gate renamed, priors resolved per step).** The harness directory is renamed
  around what may be run: `benchmark/gate.mjs` is the entry, `steps/` is what the gate runs,
  `tools/` is decision support that is never part of a release. Reports written before this date
  name the old paths (`run.mjs`, `compare.mjs`, `eval.mjs`, `release.mjs`) and keep them: a dated
  record states what was true that day. Two measurement changes travel with it. A row's prior now
  comes from the newest earlier report that ran that step rather than from the newest report alone,
  because one prior per report let a sitting that skipped a step blind the next sitting that ran it,
  and every row of that step read `no-prior`, which never blocks; the report prints how many rows
  were compared against how many had none. And every hub row measured before 2026-09-01 was taken
  against a cached corpus that had drifted from its pinned commit, since the harness appended a
  marker to the first ten notes on every invocation and never restored them. The drift is bounded
  and measured: 6,750 bytes across ten of 6,566 notes, and a same-sitting A/B of the drifted corpus
  against the same corpus stripped moved no row beyond noise, with the stripped arm reading slower
  on cold crawl, which rules out a drift penalty. Those rows stand with their provenance now stated.
  The Obsidian parity result is unaffected: `oracle.mjs` diffs our tags and links against Obsidian's
  own metadataCache over the same files, so any drift is common-mode.

## Numbers of record

The canonical digits a release gate compares against, each linking to the report that
produced it. When a number here moves, replace the value and the link together. This table is
generated by `benchmark/report.mjs`: a `PASS` sitting repoints it at the newest report, a
`BLOCK` sitting leaves it exactly as it was.

<!-- numbers -->

| metric | value | report |
|---|---|---|
| chunker grouping (D3/D4/D9) | pgc, no overlap, raw text | [2026-08-27 chunking sweep (W4)](benchmark/reports/2026-08-27-chunking-sweep-w4.md) |
| default static model | `minishlab/potion-retrieval-32M` | [2026-08-27 embedding model selection](benchmark/reports/2026-08-27-embedding-model-selection.md) |
| storage lever | int8 @ 256 dims | [2026-08-13 static-model bake-off](benchmark/reports/2026-08-13-static-model-bakeoff.md) |
| turso: hub battery (total wall) | 46.8 s | [2026-08-30](benchmark/reports/2026-08-30-0.20.0-release-gate.md) |
| duckdb: hub battery (total wall) | 68.6 s | [2026-08-30](benchmark/reports/2026-08-30-0.20.0-release-gate.md) |
| turso: 13k tree battery (total wall) | 84.4 s | [2026-08-30](benchmark/reports/2026-08-30-0.20.0-release-gate.md) |
| duckdb: 13k tree battery (total wall) | 119.3 s | [2026-08-30](benchmark/reports/2026-08-30-0.20.0-release-gate.md) |
| hub_cold_crawl_ms | 2086 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| hub_version_canary_ms | 26 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| hub_warm_query_ms | 131 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| hub_find_ms | 185 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| hub_find_row_tokens | 71 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| hub_inproc_cold_build_ms | 1838 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| hub_inproc_open_nochange_ms | 35.3 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| scale_13k_cold_crawl_ms | 3933 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| scale_13k_version_canary_ms | 28 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| scale_13k_warm_query_ms | 187 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| scale_13k_find_ms | 275 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| scale_13k_find_row_tokens | 71 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| scale_13k_inproc_cold_build_ms | 3481 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| scale_13k_inproc_open_nochange_ms | 71.2 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| scale_26k_cold_crawl_ms | 7018 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| scale_26k_version_canary_ms | 30 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| scale_26k_warm_query_ms | 293 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| scale_26k_find_ms | 443 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| scale_26k_find_row_tokens | 70 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| scale_26k_inproc_cold_build_ms | 5965 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| scale_26k_inproc_open_nochange_ms | 149.6 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| stress_cold_crawl_ms | 6085 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| stress_version_canary_ms | 28 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| stress_warm_query_ms | 93 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| stress_find_ms | 349 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| stress_find_row_tokens | 59 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| stress_inproc_cold_build_ms | 5579 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| stress_inproc_open_nochange_ms | 11.3 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_hub_cold_crawl_ms | 5926 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_hub_version_canary_ms | 27 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_hub_warm_query_ms | 162 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_hub_find_ms | 562 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_hub_find_row_tokens | 100 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_hub_inproc_cold_build_ms | 4390 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_hub_inproc_open_nochange_ms | 44.1 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_13k_cold_crawl_ms | 11867 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_13k_version_canary_ms | 26 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_13k_warm_query_ms | 219 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_13k_find_ms | 958 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_13k_find_row_tokens | 101 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_13k_inproc_cold_build_ms | 8853 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_13k_inproc_open_nochange_ms | 79.3 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_26k_cold_crawl_ms | 24461 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_26k_version_canary_ms | 27 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_26k_warm_query_ms | 329 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_26k_find_ms | 1753 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_26k_find_row_tokens | 100 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_26k_inproc_cold_build_ms | 17363 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_26k_inproc_open_nochange_ms | 156.5 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_stress_cold_crawl_ms | 47055 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_stress_version_canary_ms | 28 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_stress_warm_query_ms | 122 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_stress_find_ms | 1877 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_stress_find_row_tokens | 89 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_stress_inproc_cold_build_ms | 36756 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_stress_inproc_open_nochange_ms | 18.8 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_hub_cold_crawl_ms | 4424 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_hub_version_canary_ms | 27 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_hub_warm_query_ms | 139 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_hub_find_ms | 220 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_hub_find_row_tokens | 100 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_hub_inproc_cold_build_ms | 3466 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_hub_inproc_open_nochange_ms | 42.5 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_13k_cold_crawl_ms | 8415 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_13k_version_canary_ms | 25 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_13k_warm_query_ms | 197 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_13k_find_ms | 344 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_13k_find_row_tokens | 99 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_13k_inproc_cold_build_ms | 6240 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_13k_inproc_open_nochange_ms | 82.2 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_26k_cold_crawl_ms | 16669 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_26k_version_canary_ms | 28 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_26k_warm_query_ms | 314 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_26k_find_ms | 596 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_26k_find_row_tokens | 100 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_26k_inproc_cold_build_ms | 12308 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_26k_inproc_open_nochange_ms | 170 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_stress_cold_crawl_ms | 23158 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_stress_version_canary_ms | 27 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_stress_warm_query_ms | 98 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_stress_find_ms | 449 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_stress_find_row_tokens | 89 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_stress_inproc_cold_build_ms | 18425 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_stress_inproc_open_nochange_ms | 14.3 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| eval_nfcorpus_ndcg | 0.3427 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| eval_nfcorpus_hit | 0.7121 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| eval_fever_ndcg | 0.9337 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| eval_fever_hit | 0.9965 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| hub_semantic_find_ms | 298 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| hub_map_ms | 164 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| hub_map_tokens | 496 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| hub_peek_ms | 144 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| hub_peek_tokens | 581 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| scale_13k_semantic_find_ms | 477 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| scale_13k_map_ms | 249 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| scale_13k_map_tokens | 541 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| scale_13k_peek_ms | 200 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| scale_13k_peek_tokens | 692 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| scale_26k_semantic_find_ms | 828 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| scale_26k_map_ms | 418 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| scale_26k_map_tokens | 541 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| scale_26k_peek_ms | 316 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| scale_26k_peek_tokens | 843 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| stress_semantic_find_ms | 953 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| stress_map_ms | 122 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| stress_map_tokens | 398 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| stress_peek_ms | 110 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| stress_peek_tokens | 476 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_hub_semantic_find_ms | 666 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_hub_map_ms | 216 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_hub_map_tokens | 563 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_hub_peek_ms | 183 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_hub_peek_tokens | 581 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_13k_semantic_find_ms | 1172 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_13k_map_ms | 365 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_13k_map_tokens | 573 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_13k_peek_ms | 253 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_13k_peek_tokens | 692 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_26k_semantic_find_ms | 2022 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_26k_map_ms | 546 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_26k_map_tokens | 573 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_26k_peek_ms | 385 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_26k_peek_tokens | 843 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_stress_semantic_find_ms | 1993 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_stress_map_ms | 312 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_stress_map_tokens | 435 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_stress_peek_ms | 177 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_duckdb_stress_peek_tokens | 476 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_hub_semantic_find_ms | 507 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_hub_map_ms | 302 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_hub_map_tokens | 535 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_hub_peek_ms | 159 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_hub_peek_tokens | 581 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_13k_semantic_find_ms | 869 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_13k_map_ms | 525 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_13k_map_tokens | 541 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_13k_peek_ms | 227 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_13k_peek_tokens | 692 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_26k_semantic_find_ms | 1668 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_26k_map_ms | 987 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_26k_map_tokens | 541 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_26k_peek_ms | 371 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_26k_peek_tokens | 843 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_stress_semantic_find_ms | 2104 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_stress_map_ms | 411 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_stress_map_tokens | 398 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_stress_peek_ms | 114 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |
| battery_turso_stress_peek_tokens | 476 | [2026-09-02 release gate](benchmark/reports/2026-09-02-release-gate.md) |

<!-- /numbers -->
