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
  This is what a calling agent pays per invocation.
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
