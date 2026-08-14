# Benchmarks

Per-release measurements on a public corpus. One column per release; add a column when a release
changes performance or capability, and update the results tables below.

## Running

```bash
node benchmark/compare.mjs                             # latest published vs working tree, default corpus
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
- To add a metric: one measured field in `run.mjs`, one row in the `ROWS` table in `compare.mjs`.
  Versions lacking a verb report `—` automatically; a version that errors reports the error.
- Corpus pins live in `benchmark/lib/corpus.mjs`. If a pin must move (repo disappears, need a
  bigger corpus), regenerate every column at the new pin.

## Interpreting

- Timings are medians (wall: 5 runs, cold crawl 1; in-process: 5 no-change, 3 updates).
- Wall minus in-process ≈ per-invocation overhead: process spawn, Node/V8 startup, importing
  sense and its dependencies, argv parsing. The two move independently — if the in-process number
  grows, the engine (scan/reconcile/SQL) got slower; if the gap grows while in-process stays
  flat, startup got heavier — typically a new dependency imported at module top level, which
  every invocation pays for before any work happens. Commands lazy-load from `src/commands/`
  (cli.ts imports no tree code), so a heavy import belongs inside the one command that uses it;
  `--version` is the canary: it should stay at bare Node startup (~25 ms here).
- The update rows include everything reconcile does after re-parsing: link re-resolution across
  the whole table and a full PageRank pass. They are the numbers to watch as features add
  reconcile work.
- The bulk-change pair measures `watch`: without a watcher, the first query after many files
  change pays the whole reparse; with one running, the reparse happened in the background and
  the query pays only the freshness check.
- Token columns (`map`, `peek`) are output-size contracts, not performance: they must stay
  roughly flat as trees grow. A token number that scales with tree size is a context-bloat
  regression even if timings look fine.
- Watch for: cold build growing worse than linearly with note count; the no-change check
  drifting above ~50 ms at 10k notes; updates drifting above ~300 ms.

## Results — obsidian-hub @ b11036f9 (6,566 notes, 14 MB)

Apple Silicon, Node 26. 2026-08-12. `local` = working tree after v0.4.0 (the audit fixes);
regenerate at the next release for its real number.

| metric | 0.2.1 | local |
|---|---|---|
| cold crawl (wall) | **FAILED** | 5.7 s |
| warm query (`COUNT(*)`) | — | 72 ms |
| BM25 search (canonical join) | — | 78 ms |
| `find` (BM25 + link fusion) | — | 131 ms |
| `map` (orient) | — | 80 ms / ~452 tokens |
| `peek` largest note (~77,274 t) | — | 79 ms / ~581 tokens (0.8%) |
| bulk change (500 files): first query | — | 1.15 s |
| bulk change (500 files): with warm watcher | — | 100 ms |
| in-process: cold index build | **FAILED** | 5.8 s |
| in-process: freshness check, no change | — | 27 ms |
| in-process: update, 1 file touched | — | 116 ms |
| in-process: update, 10 files modified | — | 131 ms |

0.2.1's failure is structural, not a timing gap: `01 - Community/People/MugishoMp.md` has an
alias list entry starting with `@`, which strict YAML rejects; 0.2.1's parser (gray-matter/
js-yaml) throws with no per-file handling, so one bad file aborts the whole crawl with nothing
indexed. At real-tree scale some frontmatter is always broken. 0.3.0 parses frontmatter
leniently (`yaml` parseDocument): syntax errors become per-file warnings and the values —
including the `@` alias — are kept.

The update rows are dominated by post-parse reconcile work (whole-table link re-resolution +
PageRank), not by re-parsing: 1 file vs 10 files differs by only ~20 ms.

## Scale

The README's note-count claim is measured, not extrapolated: `obsidian-hub-x2` and
`obsidian-hub-x4` (13k / 26k notes) are named corpora that replicate the pinned hub tree
N times under one root — real notes, real frontmatter, real links, regenerated from
nothing like every corpus. Duplicate basenames across copies stress link-ambiguity
resolution harder than a natural tree. Run `node benchmark/run.mjs . <corpusPath>` per
tree; regenerate scale rows together with the main table.

What the scale rows watch, in order of what actually breaks: the per-query freshness
check (stats every file — linear, the cost every call pays), cold crawl (linear —
a quadratic here was found and fixed at 13k/26k: FTS5 DELETE by column scans the whole
table, and delete-before-insert ran per doc on cold builds where the table was empty),
reconcile after updates (linear; dominated by whole-table link re-resolution plus a full
PageRank pass), and the watcher race (a query during the watcher's bulk write transaction
waits on `busy_timeout` — sized at 30s to cover ~3x the largest measured reconcile).

## Retrieval quality

`benchmark/eval.mjs <corpus>` runs every labeled query through `find` in two variants —
BM25-only (links and rank off) and fused (BM25 + link expansion) — and reports nDCG@10,
MRR@10, and hit@10 against the corpus qrels. Queries are natural-language text, submitted
as an OR bag of words (the standard bag-of-words baseline; bare FTS5 terms AND-join and
punctuation is syntax). Labeled corpora convert their labels to one format
(`labels/queries.jsonl` + `test.tsv`, read by `benchmark/lib/labels.mjs`):

- **nfcorpus** — BEIR NFCorpus: 3,633 medical abstracts, 323 queries, graded qrels
  (~38 judged/query). No links, so it measures BM25 recall; both variants score identically.
- **fever** — FEVER dev split: Wikipedia intro pages cited as evidence by verifiable claims,
  with sentence link annotations kept as wikilinks. The claims are the queries; the corpus
  that can measure whether link fusion helps or hurts ranking.

Results (macOS arm64, Node 24, 2026-08):

| metric | nfcorpus bm25-only | nfcorpus fused | fever bm25-only | fever fused |
|---|---|---|---|---|
| nDCG@10 | 0.3233 | 0.3233 | 0.9436 | 0.9361 |
| MRR@10 | 0.5185 | 0.5185 | 0.9508 | 0.9381 |
| hit@10 | 0.6873 | 0.6873 | 0.9969 | 0.9971 |
| mean ms/query | 3.5 | 5.0 | 7.6 | 15.2 |

The published BEIR BM25 (Anserini) baseline for NFCorpus is nDCG@10 ≈ 0.32 — the FTS5
pipeline matches it, so `find`'s lexical layer is a faithful BM25, and the identical fused
column confirms fusion is a no-op on a linkless corpus.

On FEVER, claims quote their evidence pages' vocabulary almost verbatim, so BM25 alone is
near-saturated (99.7% hit@10) — little headroom for fusion to help. Within that: fusion
recovers a handful of BM25 misses (hit@10 +0.02 points) but costs ~1 point of MRR/nDCG
(link neighbors occasionally rerank above the true evidence page) and doubles per-query
latency. The eval detects sub-point ranking deltas; use it before and after any change to
`find`'s fusion or scoring.

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

| | 0.2.1 | 0.3.0 |
|---|---|---|
| frontmatter filter + FTS5 search | ✓ | ✓ |
| links table, backlinks, dead links | — | ✓ |
| sections table, outline with line ranges | — | ✓ |
| PageRank (`_rank`), hub detection | — | ✓ |
| fused retrieval (`find`, `via` column) | — | ✓ |
| bounded orient/structure verbs (`map`, `peek`) | — | ✓ |
| lenient frontmatter (syntax errors → warnings, values kept) | — | ✓ |
| config auto-migration | — | ✓ |
| feature toggles | — | ✓ |
| `--version` | — | ✓ |
