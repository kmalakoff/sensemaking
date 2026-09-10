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
npm run benchmark                     # ordinary assessment: required stages selected from the diff
npm run benchmark -- --profile deep   # explicit deep assessment
npm run benchmark -- --dry-run        # selected stages, reasons, and historical-cost estimate; measures nothing
node benchmark/report.mjs             # re-render a report from its sitting, measuring nothing
node benchmark/report.mjs --sitting <archived-sitting> --out <assessment-dir> [--native-matrix <matrix.json>] # render isolated assessment files without changing retained evidence
```

`ordinary` is the default release assessment. The changed capabilities select its common
correctness and matched-input current-store work. Its fresh or retained relevance view is the full
portable NFCorpus workload on every offered store. `deep` explicitly adds the large scale/stress
workloads, portable FEVER on every store, and the legacy SQLite OR-bag continuity rows. The dry run
records the selected profile, reasons, and an estimate based on historical execution data. Its
10–20 minute ordinary target is an estimate, not a proven current duration.

When an ordinary run owes a baseline assessment but no changed capability requires fresh retrieval
collection, it first revalidates retained raw portable NFCorpus quality against the current
retrieval, model, corpus, query, judgment, and all-store identities. Missing or incompatible raw
evidence selects fresh portable NFCorpus before any work starts; compact report summaries alone
cannot stand in for that revalidation. If the retained revalidation step has no historical cost and
is still pending, ordinary uses the known bounded fresh NFCorpus path rather than escalating to
FEVER. An applicable completed retained step is still reused on resume. The fallback is not a
calibrated retained-revalidation estimate. The sitting and final report retain the selected profile,
scope, and requirements, and a resume must be compatible with them. Native diagnostic matrices and
historical sweeps are omitted unless explicitly requested; neither profile selects them
automatically.

The steps, each runnable alone when investigating one thing:

```bash
node benchmark/steps/measure-tree.mjs . <notes-dir|corpus>          # one package against one tree; the JSON row everything else reads
node benchmark/steps/compare-versions.mjs                           # released baseline (package.json) vs working tree
node benchmark/steps/compare-versions.mjs obsidian-hub 0.2.1 local  # explicit corpus and versions
node benchmark/steps/quality.mjs nfcorpus                           # retrieval quality on a labeled corpus
node benchmark/steps/oracle.mjs <corpus> <path>                     # tags/links/chunk extents vs Obsidian's metadataCache
node benchmark/steps/store-dump.mjs capture <dir>                   # every store's rows and ranked output, for an A/B against a refactor
node benchmark/steps/store-dump.mjs compare <dirA> <dirB>           # diffs two captures, non-zero on any difference
node benchmark/tools/native-capability.mjs [--store STORE] [--case CASE] [--notes N] [--out FILE] # tiny native API diagnostic
node benchmark/tools/duckdb-lexical-cost.mjs --out FILE             # optional DuckDB lexical-path diagnostic
node benchmark/tools/turso-update-cost.mjs --out FILE               # optional Turso 250-file update-strategy diagnostic
node benchmark/tools/result-sets.mjs [corpus ...] [--queries lexical,words,default] [--k 10] [--out FILE] # ranked-path overlap evidence
```

The DuckDB diagnostic records the real adapter's prepare and execute/read/JavaScript-conversion
boundaries; query construction and phrase verification remain outside those connection spans. The
Turso diagnostic runs both real content-index strategies on the same 250 changed paths and records
transaction, drop/delete/insert/create/commit boundaries while excluding outer reconciliation.
Both are optional fixed-work diagnostics, not release rows: they do not establish a pure-native
cost, select an optimization, or change a production threshold.

The native-capability v3 diagnostic defaults to SQLite, the `baseline` case, four authored notes, and three fresh repetitions. It accepts one store at a time. Generate one artifact per store, keeping `--case` identical, then compare exactly the SQLite, DuckDB, and Turso artifacts:

```bash
node benchmark/tools/native-capability.mjs --store sqlite --case baseline --notes 4 --out .tmp/native-capability/sqlite-baseline.json
node benchmark/tools/native-capability.mjs --store duckdb --case baseline --notes 4 --out .tmp/native-capability/duckdb-baseline.json
node benchmark/tools/native-capability.mjs --store turso --case baseline --notes 4 --out .tmp/native-capability/turso-baseline.json
node benchmark/tools/native-capability-compare.mjs .tmp/native-capability/sqlite-baseline.json .tmp/native-capability/duckdb-baseline.json .tmp/native-capability/turso-baseline.json --out .tmp/native-capability/baseline-comparison.json
```

The comparator is fail-closed on schema, store set, case/workload inputs, row identities, implementation/package/harness identity, runtime, machine, and quiet-readiness differences; core authored path, content, pending-vector, and rounded geometry postconditions pass before timing rows are eligible. It accepts only v3 artifacts from the same case, not historical v1/v2 artifacts, and compares no pair or subset in place of the required three stores. Each comparison input is bounded to 16 MiB. The CLI always uses three repetitions; the library contract allows 3–100, and `--notes` accepts 4–50,000. The diagnostic reports timings without adding release rows or choosing a fastest store.

For an owner-run evidence matrix, run the bounded driver after validation and a successful build:

```bash
node benchmark/tools/native-evidence-matrix.mjs \
  --out-dir .tmp/native-matrix-<date> \
  --baseline-notes 6
```

The driver runs each of the seven cases on SQLite, DuckDB, and Turso, repeats `baseline` at four
and six notes, then measures 249, 250, and 251 changed files on separately prepared 260-note trees.
It compares every three-store group and writes `matrix.json` with the generated artifact paths and
sha256/byte manifest for every artifact and comparison. The output directory must be new or empty;
the driver atomically records `running`, then `failed` on an interrupted/error run, so a stale
successful summary cannot be reused. It runs sequentially and stops at the first failed command,
retaining the failed summary and completed artifacts. The native-update artifacts record that the initial index was built
and queried once before close. Their measured state is the first and second lexical queries after
the deterministic update and reopen. The first query includes any lazy native rebuild; the second
is the warmed lexical reading. These update measurements are diagnostics, not release timing rows.

The seven v3 cases change bounded workload axes:

| case | controlled fixture axis |
|---|---|
| `baseline` | four authored notes, 256-byte vector wire rows, candidate `k=3`, similar `k=2` |
| `large-content` | one authored note is exactly 1 MiB including its final newline, mostly one repeated `x` run; it is not a 254k-word stress or snippet workload |
| `dense-terms` | repeated `needle` terms in the two matching notes |
| `broad-matches` | the two nonmatching baseline notes also contain `needle` |
| `top-one` | candidate and similar limits are both `k=1` |
| `narrow-vectors` | vector wire rows and query use 64 dimensions while the native schema remains 256 dimensions |
| `structured-content` | four structured lexical notes add authored frontmatter/status, heading levels 1–4, and an `a↔b` link pair; filler notes appear when `--notes` exceeds four, and the vector tree remains the baseline fixture for the requested count |

These cases are workload-axis observations, not strict one-covariate experiments and not cross-case causal claims; compare stores only within one case. The `structured-content` facts are authored frontmatter/status, heading levels 1–4, and the `a↔b` lexical links; they are checked after the content-read timer and add no timing row or shape-performance claim. The `measure-tree.mjs` table output remains opaque: its rows are not reverse-parsed into a correctness claim. Native-capability output is structured JSON; lexical checks retain an output hash and authored path postconditions, but do not claim snippet or hydration equivalence. Its fixed `content_read` row is a native SQL read of authored `content` rows, not production search hydration. Public `open` timing includes shared parse/reconcile orchestration and native work; cold and warm lexical timers stop before shared search fusion and snippet construction. Source-file manifests and explicit int8-plus-scale wire vectors are separate workload evidence; no embedding provider is constructed by this diagnostic, and changing wire or native-schema dimensions changes the workload identity. Optional native provenance records the package name/version and engine version query, not a cryptographic hash of the native binary. This remains a standalone diagnostic: release owners control whether any later comparison enters a stage or gate, and no timing bands or stored acceptances change here.

The tools, for settling a decision rather than gating a release:

```bash
node benchmark/tools/bakeoff.mjs nfcorpus       # storage-lever bake-off for one model
node benchmark/tools/weight-sweep.mjs nfcorpus  # per-signal RRF weight sweep
node benchmark/tools/sweep.mjs                  # the shape sweep behind the stress corpus
node benchmark/tools/profile.mjs                # cold build by stage
node benchmark/tools/shared-snippet.mjs         # shared snippet + line lookup, measured once
node benchmark/tools/native-hydration.mjs --store sqlite
node benchmark/tools/native-hydration-compare.mjs sqlite.json duckdb.json turso.json
```

The release baseline stage runs the shared snippet check once and fixed-candidate production hydration on every offered store. Hydration uses the same non-ranked candidate order with short, medium, multi-section and exactly 1 MiB word-dense notes. The large note contains over 250,000 short words, not a single long token. Both default and larger caller budgets require exact authored snippets and line ranges on every store. The file bytes and candidate order identify the workload, so the earlier single-word fixture cannot supply a compatible baseline. These steps gate artifact and correctness validity only; their timings have no catalog row, band or stored acceptance. Fixed-path native SQL content reads remain a different diagnostic.

The baseline and scale stages also capture ranked path evidence on the hub and stress corpora,
respectively, before the expensive timing those artifacts protect. These checks fail on invalid or
missing store captures, while their pairwise overlap remains descriptive and never gates a
performance number. The release report renders the pairwise path overlap so a ranking or corpus
change is visible without treating another store as the correctness oracle.

`result-sets.mjs` captures the exact ranked path lists for the lexical, words-only, and default
searches from every declared store. Each store receives a fresh private copy of the same corpus,
query arguments, configuration, and `k`; the artifact records their common workload fingerprint and
fails on a missing store, command error, malformed row, duplicate path, or path outside the corpus.
The pairwise Jaccard and top-1 fields are descriptive evidence of selected-work divergence. They do
not decide correctness, choose a winner, repin candidates, or gate a timing row. Use authored
fixtures or qrels to judge retrieval, and read a changed path set as a reason to investigate the
native ranking contract before comparing downstream timings.

Release comparisons require each current row to carry a recomputable workload identity. A prior with a missing or different identity is reported as `no-compatible-prior` and is not numerically compared or counted as a pass. Owner acceptances bind to the exact classification or stage evidence; legacy and changed-workload acceptances are retained as stale evidence but are not applied.

The generated assessment has two views. Current fixed-work costs compare SQLite, DuckDB, and Turso only after the shared snippet work, fixed files, ordered candidates, caller budgets, output checks, readiness, and sample coverage validate. It shows shared work once, then each store's samples, range, median, and ratio. Native-selected end-to-end readings remain separate diagnostics because ranking can select different downstream work. Compatible history follows each store and capability on matching logical work. It reports timing and relevance separately, with valid numeric comparisons, invalid readings, and not-compared rows counted independently. Implementation fingerprints record provenance. They do not make two logical workloads compatible.

Invalid required evidence and failed required behavior block the verdict. Historical timing, quality, and output observations warn unless an artifact names an explicit caller bound, quality floor, or approved guard. Missing history is information, not a pass. A store-dump or snapshot difference needs contract review before the report can call it a warning.

A run resumes by default. Independent failures are collected in one sitting; a failed build/test prerequisite or missing producer output prevents only dependent work. Snippet, result-set and store-dump evidence failures do not suppress independent measurements, and still block the final verdict. The sitting is keyed on the tree it measures, so an interrupted run reuses successful steps and editing code starts a fresh one. Unaccepted failures retry; accepted failures remain recorded. One store or one tree alone is `measure-tree.mjs`, below. Normal exits clean private measurement copies; a forcibly killed process can leave a `.tmp/run-*` copy. The gate does not delete unidentified copies that may belong to another active run.

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

- **Wall-time:** spawns the CLI per operation, so every number includes ~40 ms of Node startup. This is what a calling agent pays per invocation. On embed-enabled trees `measure-tree.mjs` also times `search` with vectors (`semantic_find_ms`). The difference from `find_ms` is a derived end-to-end diagnostic, not an isolated semantic cost: selected candidates, readiness, model loading, query embedding, vector scan, and downstream work can differ (null on trees without embed).
- **In-process:** imports the version's `dist/esm/index.js` as a library and times the engine entry point: cold index build, the no-change freshness check, and incremental updates (1 file touched, 10 files modified). Native backend behavior remains part of the result.

## Maintaining

- Regenerate **all** columns of a table in one sitting on one machine. Numbers are not comparable across machines or Node versions. Record machine + Node in the report's frontmatter.
- Regenerate **before** the version bump, not after publishing: a benchmark run is only a release gate if a bad number can still stop the release. See [RELEASING.md](RELEASING.md).
- The performance tables regenerate every release; the retrieval-quality tables regenerate when retrieval itself changes: fusion, ranking, the default model, tokenizer, chunking. A quality report older than the current version is expected, and says the ranking has not moved since; a retrieval change shipped without a fresh report is the gap to catch.
- To add a metric: one measured field in `measure-tree.mjs` and one row in `benchmark/lib/rows.mjs`, the single catalog every table and frontmatter key derives from. Versions lacking a command report `—` automatically; a version that errors records the error against the row.
- Corpus pins live in `benchmark/lib/corpus.mjs`. If a pin must move (repo disappears, need a bigger corpus), regenerate every column at the new pin.
- Each sitting is a new file in `benchmark/reports/`, never an edit to a previous one, and nothing is deleted: the gate resolves a row's prior from the newest earlier report that ran that step, so the history is what makes a comparison possible. A tracked release JSON is a compact projection: it keeps row identities, numerics, errors, verdict, and assessment needed for compatible comparisons; raw evidence remains in its named sitting and omitted fields carry canonical hashes and byte counts, so the record does not claim to revalidate them. "Numbers of record" below is repointed by `report.mjs` on a PASS, never by hand. Add a "Methodology changelog" entry only when the change is about HOW something is measured (a new guard, a new corpus, a harness bug fix, a discipline rule); a numbers-only regeneration gets a report file and nothing else.

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
- Subtractions and comparisons between wall-time and in-process rows are derived diagnostics, not mechanism measurements. The entry points, selected candidates, readiness state, cache behavior, and sometimes feature configuration differ, so a change in a difference does not isolate process startup, engine, or import cost. The derived `setup_ms` row (warm query minus in-process open) is likewise a workload difference, not a measured setup phase. `version_canary_ms` is the bare-startup floor, a median of 5 `--version` spawns, and it is answered before any command loads; inspect the individual rows and stage data when describing what was timed (PLAN.md 3.11).
- The update rows include everything reconcile does after re-parsing: link re-resolution across the whole table and a full PageRank pass. They are the numbers to watch as features add reconcile work.
- Each repetition of the bulk-change pair starts from a verified fresh private copy, builds an unmeasured native baseline, and applies the same deterministic mtime-only change set. `bulk_change_ms` times the built CLI query that discovers and reconciles those changes. `bulk_watch_ms` starts the measured package's public `runWatch` in a child, treats watcher events only as wake-ups, and waits for a separate direct-dialect observer to verify the exact stored paths, mtimes, sizes, and content hashes before timing the built CLI query. The query's count is a supplementary stdout check, not the freshness proof. The observer runs outside the timer and may warm native caches; SQLite connection setup, DuckDB function registration, and Turso WAL checkpointing on observer close are part of that preparation boundary. Copy, baseline-build, watcher-start, readiness, and observer costs are recorded separately. The pair remains a diagnostic comparison of different end-to-end states, not an isolated reparse or freshness cost.
- Token columns (`map`, `peek`, `search` row) are output-size contracts, not performance: they must stay roughly flat as trees grow. A token number that scales with tree size is a context-bloat regression even if timings look fine. The `search` row is measured in json, per row actually returned, and tracks summary and snippet length rather than tree size. `find_row_tokens` is a rounded output-size estimate, not a token count or proof that snippets are identical. Hashes establish identity, not correctness; correctness still needs explicit path, value, snippet, and line-range assertions. The difference between `find_ms` and `words_ms` compares selected-candidate workloads and does not isolate word matching, link expansion, or downstream hydration.
- Watch for: cold build growing worse than linearly with note count; the no-change check drifting above ~50 ms at 10k notes; the update rows drifting away from the freshness check they now track (the difference is a derived workload comparison, not isolated update work); any stress-table row moving (each guards a fixed shape cliff). A report-only `kind: total` row has no performance movement threshold, but named invocation errors and invalid artifacts still block the gate.
- DuckDB's `fm-upsert` stage (the frontmatter upsert during a cold build) costs about 100 ms on the hub corpus against a negligible figure on sqlite. It only entered the top stages after 0.23.0 swapped the markdown parser, not because the cost changed but because parse halved around it. About 79% of it is DuckDB's own per-value cast of the corpus's dynamic frontmatter fields into `VARIANT` columns, a flat per-call tax regardless of column or value shape, and it is not a defect in our write path: the appender `fm-upsert` uses is already the fast path, a bound `INSERT` loop into the same column measured roughly 53x slower. `VARIANT` is deliberate, not an oversight: it is what lets a duckdb user query `tags` as a list or `publish` as a boolean straight from SQL. No fix is proposed here: a type-hint experiment was tried and withdrawn as unmeasured guesswork about DuckDB's own binding internals, and swapping `VARIANT` for `VARCHAR` was rejected too, since it would trade that query capability for about 80 ms. Full measurement: PLAN.md 3.49 Track D.

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

Use `--query-form or-bag|bare-and` to select the quality workload. `or-bag` is the default and preserves the historical series; `bare-and` is the portable track, which uses one required query form and the same qids, qrels, corpus, and `k` for each store. Quality artifacts record the exact source and canonical query text, qrels, store, query form, and returned paths, so a result identifies the workload it measured without treating path agreement as a correctness oracle.

The ordinary release gate runs NFCorpus as a portable `bare-and` track on every offered store.
Deep adds portable FEVER and retains the historical SQLite OR-bag rows for both corpora. The
comparator checks the exact corpus, split, qrels, query form, `k`, model/config identity, and
complete per-query coverage before relevance results are classified. A new portable workload is
visible as `no-compatible-prior` until it has its own baseline; retrieval errors, incomplete
coverage, and invalid artifacts block. Ordinary does not relabel omitted FEVER or legacy rows as
passing evidence.

Quality index reuse is identity-keyed and private per invocation. Each run copies Markdown from the pinned source, optionally carries a verified completed `.sense` cache into that private copy, and publishes a new immutable generation only after every variant, guard, and native close succeeds. The identity includes source bytes and mtimes, exact index configs, source/dist/harness and native-package provenance, and byte hashes of both supported static-model files (with the local Hugging Face ref recorded separately). A missing local model or unknown remote revision is never presumed reusable. Completed Markdown and native-cache files are hash-verified before reuse; malformed or changed generations fail preflight instead of being trusted by file count. Query text, qrels, split, and `k` remain separate result-workload evidence because they do not shape the stored index. These checks establish cache identity, not retrieval correctness; the authored qrels and guard passes remain the oracle.

Two guards run before any number is reported:

- **Bit-identity.** The guard pass must return rows identical to fused, query for query; a divergence aborts the run with a nonzero exit. This is what makes "a vectors-free preset changes nothing on an embed-configured tree" a tested claim rather than a design intention.
- **Paired per-query deltas.** Point metrics hide whether a change moved many queries a little or a few queries a lot, and at these sample sizes a 0.01 difference can be noise. Every comparison also reports wins/losses and a sign-test z (|z| > 2 is beyond noise).

Labeled corpora convert their labels to one format (`labels/queries.jsonl` + `test.tsv`, read by `benchmark/lib/labels.mjs`):

- **nfcorpus:** BEIR NFCorpus, 3,633 medical abstracts, 323 queries, graded qrels (~38 judged/query). No links, so fused equals bm25-only; it measures lexical recall and the vocabulary gap semantic expansion targets.
- **fever:** FEVER dev split, 2,860 Wikipedia pages cited as evidence by 13,229 verifiable claims, with sentence link annotations kept as wikilinks. The claims are the queries; the corpus that can measure whether link fusion helps or hurts ranking.
- **miracl-\<lang\>:** per-language MIRACL (`benchmark/lib/corpus.mjs`'s `miracl` builder), judged docs as a floor plus reservoir-sampled distractors toward ~3-5k docs. The multilingual counterpart to nfcorpus/fever's English-only pair; CJK-script queries need `orBag`'s unigram split (see the methodology changelog) or they score at chance level.

Storage-lever and fusion-weight choices (dims, int8 vs f32, per-signal RRF weight) are measured against these same corpora by `bakeoff.mjs` and `weight-sweep.mjs`. The historical NFCorpus comparison reported nDCG@10 ≈ 0.32 for both the published BEIR BM25 (Anserini) baseline and this FTS5 pipeline. Similar aggregate relevance scores do not prove identical retrieval semantics or implementation correctness. NFCorpus and FEVER exercise different vocabulary gaps: layman queries over jargon versus claims close to their evidence. Evaluate changes against both; the current portable quality artifacts, not these historical observations, provide release evidence.

Current numbers: see "Numbers of record" below.

## The chunking algorithm

The unit sense embeds is a block from the parsed markdown token tree, not a raw text slice.
Headings are hard boundaries: a chunk never spans one, and a heading is never orphaned from
the content under it. Inside a section, consecutive paragraphs pair up, capped by the
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
  row (snippet length as a size contract, not a timing).
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
  measuring it. `benchmark/report.mjs` renders a sitting's `release-gate.{json,md}` beside its data,
  and `--release <version>` copies it to `benchmark/reports/<date>-<version>-release-gate.{json,md}`.
  It is the only writer of the numbers-of-record table below: releasing a `PASS` sitting
  repoints it, a `BLOCK` or an unreleased sitting leaves it untouched, and `report.mjs --accept <row id | stage reason> --reason
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

- **2026-09-06 (timeline: 30 min budget, pairs that never finish are not re-measured).**
  `tools/timeline.mjs` defaults to a 30 minute per-run budget rather than 2 hours. A version-store
  pair killed at the budget drops its remaining repeats, read from the kill logs on disk so a
  stopped sitting resumes knowing it. `benchmark/timeline-skips.json` lists pairs not measured at
  all; entries are added by hand after reading a kill log, never by the tool. Its one entry is
  0.19.0 with store turso, whose cold build is quadratic in note count (945 s on the hub corpus,
  fixed in 0.19.1), so one run needs over two hours. A plain non-zero exit is not a kill and is
  still retried; `--retry-killed` measures everything anyway.

- **2026-09-08 (m4 repeat isolation and bulk readiness).** In-process no-change, one-file, ten-file, cold-build, bulk-change, and bulk-watch rows now use independent fresh private copies of an untouched source. The harness verifies canonical paths, bytes, hashes, sizes, and copied mtimes before timing; deterministic mutations and exact postconditions make repeated output state explicit. Bulk watcher readiness is established by a direct native snapshot after the measured package's public `runWatch` child reports wake-up events, not by sleeping or by treating an event as completion. Preparation and observer costs are reported separately and excluded from timed rows. This is a provisional method with no comparable m3 baseline, so owner calibration remains due. Complete workload provenance, lexical readiness for the other query rows, and expanded metadata/render coverage remain in progress.

## Numbers of record

The canonical digits a release gate compares against, each linking to the report that
produced it. When a number here moves, replace the value and the link together. This table is
generated by `benchmark/report.mjs`: a `PASS` sitting repoints it at the newest report, a
`BLOCK` sitting leaves it exactly as it was.

These are historical per-store diagnostics, including same-store end-to-end and in-process workload records. They are not a cross-store leaderboard for identical work: logical workload, selected candidates, downstream rows, and readiness can differ. Native physical plans differ intentionally and are part of the store comparison, but a ranking-dependent number does not establish identical downstream work or an overall store winner.

The rows below come from the accepted 0.24.0 full release-gate sitting. They include the corrected search output, shared snippet work, fixed hydration, and common-query relevance evidence. No separate native-capability matrix was attached to this sitting; its native selected-path diagnostics remain descriptive rather than fixed-work cross-store comparisons.

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
| hub_cold_crawl_ms | 1471 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| hub_version_canary_ms | 27 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| hub_warm_query_ms | 138 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| hub_find_ms | 193 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| hub_find_row_tokens | 81 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| hub_inproc_cold_build_ms | 1034 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| hub_inproc_open_nochange_ms | 42.1 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| scale_13k_cold_crawl_ms | 2025 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| scale_13k_version_canary_ms | 28 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| scale_13k_warm_query_ms | 195 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| scale_13k_find_ms | 297 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| scale_13k_find_row_tokens | 82 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| scale_13k_inproc_cold_build_ms | 1470 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| scale_13k_inproc_open_nochange_ms | 75.7 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| scale_26k_cold_crawl_ms | 3932 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| scale_26k_version_canary_ms | 29 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| scale_26k_warm_query_ms | 334 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| scale_26k_find_ms | 496 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| scale_26k_find_row_tokens | 81 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| scale_26k_inproc_cold_build_ms | 2867 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| scale_26k_inproc_open_nochange_ms | 142.1 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| stress_cold_crawl_ms | 3431 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| stress_version_canary_ms | 29 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| stress_warm_query_ms | 79 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| stress_find_ms | 618 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| stress_find_row_tokens | 68 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| stress_inproc_cold_build_ms | 2741 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| stress_inproc_open_nochange_ms | 11.9 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_hub_cold_crawl_ms | 2147 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| battery_duckdb_hub_version_canary_ms | 27 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| battery_duckdb_hub_warm_query_ms | 164 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| battery_duckdb_hub_find_ms | 266 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| battery_duckdb_hub_find_row_tokens | 80 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| battery_duckdb_hub_inproc_cold_build_ms | 1265 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| battery_duckdb_hub_inproc_open_nochange_ms | 45.6 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| battery_duckdb_13k_cold_crawl_ms | 3242 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_13k_version_canary_ms | 28 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_13k_warm_query_ms | 230 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_13k_find_ms | 388 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_13k_find_row_tokens | 82 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_13k_inproc_cold_build_ms | 1870 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_13k_inproc_open_nochange_ms | 76.5 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_26k_cold_crawl_ms | 6097 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_26k_version_canary_ms | 29 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_26k_warm_query_ms | 367 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_26k_find_ms | 610 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_26k_find_row_tokens | 81 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_26k_inproc_cold_build_ms | 3662 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_26k_inproc_open_nochange_ms | 148.7 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_stress_cold_crawl_ms | 7882 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_stress_version_canary_ms | 31 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_stress_warm_query_ms | 117 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_stress_find_ms | 454 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_stress_find_row_tokens | 68 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_stress_inproc_cold_build_ms | 4023 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_stress_inproc_open_nochange_ms | 19 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_hub_cold_crawl_ms | 2384 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| battery_turso_hub_version_canary_ms | 27 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| battery_turso_hub_warm_query_ms | 135 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| battery_turso_hub_find_ms | 229 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| battery_turso_hub_find_row_tokens | 80 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| battery_turso_hub_inproc_cold_build_ms | 1673 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| battery_turso_hub_inproc_open_nochange_ms | 41.6 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| battery_turso_13k_cold_crawl_ms | 3933 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_13k_version_canary_ms | 29 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_13k_warm_query_ms | 209 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_13k_find_ms | 379 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_13k_find_row_tokens | 80 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_13k_inproc_cold_build_ms | 2886 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_13k_inproc_open_nochange_ms | 82.1 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_26k_cold_crawl_ms | 8111 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_26k_version_canary_ms | 30 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_26k_warm_query_ms | 403 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_26k_find_ms | 671 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_26k_find_row_tokens | 81 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_26k_inproc_cold_build_ms | 6422 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_26k_inproc_open_nochange_ms | 163.6 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_stress_cold_crawl_ms | 9850 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_stress_version_canary_ms | 30 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_stress_warm_query_ms | 87 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_stress_find_ms | 493 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_stress_find_row_tokens | 68 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_stress_inproc_cold_build_ms | 7133 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_stress_inproc_open_nochange_ms | 14.7 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| eval_nfcorpus_ndcg | 0.3426 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| eval_nfcorpus_hit | 0.7121 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| eval_fever_ndcg | 0.9337 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| eval_fever_hit | 0.9965 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| hub_semantic_find_ms | 333 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| hub_map_ms | 175 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| hub_map_tokens | 548 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| hub_peek_ms | 134 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| hub_peek_tokens | 581 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| scale_13k_semantic_find_ms | 521 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| scale_13k_map_ms | 279 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| scale_13k_map_tokens | 555 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| scale_13k_peek_ms | 210 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| scale_13k_peek_tokens | 692 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| scale_26k_semantic_find_ms | 932 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| scale_26k_map_ms | 517 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| scale_26k_map_tokens | 555 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| scale_26k_peek_ms | 360 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| scale_26k_peek_tokens | 843 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| stress_semantic_find_ms | 1274 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| stress_map_ms | 111 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| stress_map_tokens | 411 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| stress_peek_ms | 94 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| stress_peek_tokens | 476 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_hub_semantic_find_ms | 385 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| battery_duckdb_hub_map_ms | 249 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| battery_duckdb_hub_map_tokens | 580 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| battery_duckdb_hub_peek_ms | 198 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| battery_duckdb_hub_peek_tokens | 581 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| battery_duckdb_13k_semantic_find_ms | 605 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_13k_map_ms | 413 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_13k_map_tokens | 587 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_13k_peek_ms | 258 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_13k_peek_tokens | 692 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_26k_semantic_find_ms | 905 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_26k_map_ms | 624 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_26k_map_tokens | 587 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_26k_peek_ms | 423 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_26k_peek_tokens | 843 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_stress_semantic_find_ms | 585 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_stress_map_ms | 330 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_stress_map_tokens | 449 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_stress_peek_ms | 167 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_duckdb_stress_peek_tokens | 476 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_hub_semantic_find_ms | 558 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| battery_turso_hub_map_ms | 280 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| battery_turso_hub_map_tokens | 548 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| battery_turso_hub_peek_ms | 151 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| battery_turso_hub_peek_tokens | 581 | [2026-09-10 release gate](benchmark/reports/2026-09-10-0.24.3-release-gate.md) |
| battery_turso_13k_semantic_find_ms | 984 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_13k_map_ms | 505 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_13k_map_tokens | 555 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_13k_peek_ms | 238 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_13k_peek_tokens | 692 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_26k_semantic_find_ms | 1871 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_26k_map_ms | 963 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_26k_map_tokens | 555 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_26k_peek_ms | 415 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_26k_peek_tokens | 843 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_stress_semantic_find_ms | 2429 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_stress_map_ms | 404 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_stress_map_tokens | 411 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_stress_peek_ms | 102 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |
| battery_turso_stress_peek_tokens | 476 | [2026-09-09 release gate](benchmark/reports/2026-09-09-0.24.0-release-gate.md) |

<!-- /numbers -->
