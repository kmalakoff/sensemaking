# Benchmarks

Per-release measurements on a public corpus. One column per release; add a column when a release
changes performance or capability, and update the results tables below.

## Running

```bash
git clone --depth 100 https://github.com/community-archive/obsidian-hub /tmp/obsidian-hub
git -C /tmp/obsidian-hub checkout b11036f9a4db77917a4f07804541cceffc96cc66   # pinned corpus
node bench/compare.mjs /tmp/obsidian-hub 0.2.1 local                          # paste-ready table
```

`compare.mjs` does the whole flow: installs each npm version into a temp dir (`local` = this
working tree), gives every version an isolated copy of the tree with a v1 config (the lowest
common denominator every version can read; copies keep cache formats and config auto-migration
from cross-contaminating), runs `bench/run.mjs` per version, and prints the table. `run.mjs` can
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
- The corpus is pinned to the commit above for cross-release consistency. If it must move
  (repo disappears, need a bigger corpus), regenerate every column at the new pin.

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
- Token columns (`map`, `peek`) are output-size contracts, not performance: they must stay
  roughly flat as trees grow. A token number that scales with tree size is a context-bloat
  regression even if timings look fine.
- Watch for: cold build growing worse than linearly with note count; the no-change check
  drifting above ~50 ms at 10k notes; updates drifting above ~300 ms.

## Results — obsidian-hub @ b11036f9 (6,566 notes, 14 MB)

Apple Silicon, Node 26. 2026-08-12.

| metric | 0.2.1 | 0.3.0 |
|---|---|---|
| cold crawl (wall) | **FAILED** | 5.6 s |
| warm query (`COUNT(*)`) | — | 71 ms |
| BM25 search (canonical join) | — | 76 ms |
| `find` (BM25 + link fusion) | — | 132 ms |
| `map` (orient) | — | 76 ms / ~452 tokens |
| `peek` largest note (~77,274 t) | — | 76 ms / ~581 tokens (0.8%) |
| in-process: cold index build | **FAILED** | 5.6 s |
| in-process: freshness check, no change | — | 27 ms |
| in-process: update, 1 file touched | — | 115 ms |
| in-process: update, 10 files modified | — | 134 ms |

0.2.1's failure is structural, not a timing gap: `01 - Community/People/MugishoMp.md` has an
alias list entry starting with `@`, which strict YAML rejects; 0.2.1's parser (gray-matter/
js-yaml) throws with no per-file handling, so one bad file aborts the whole crawl with nothing
indexed. At real-tree scale some frontmatter is always broken. 0.3.0 parses frontmatter
leniently (`yaml` parseDocument): syntax errors become per-file warnings and the values —
including the `@` alias — are kept.

The update rows are dominated by post-parse reconcile work (whole-table link re-resolution +
PageRank), not by re-parsing: 1 file vs 10 files differs by only ~20 ms.

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
