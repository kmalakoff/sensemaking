---
date: 2026-08-27
title: chunking sweep (W4) — closes D3/D4/D9
machine: Apple Silicon
node: '26.7.0'
corpora:
  - nfcorpus
  - miracl-zh
  - obsidian-hub
  - fever
models:
  - minishlab/potion-retrieval-32M
  - qwen3-embedding:0.6b
nfcorpus_v1_ndcg10_semantic: 0.3431
miraclzh_v1_ndcg10_semantic: 0.6165
fever_v1_ndcg10_semantic: 0.9340
verdict_group_size: pgc
verdict_overlap: none
verdict_text: raw
---

The algorithm this sweep validates is described in BENCHMARKING.md's "The chunking algorithm"
section (durable narrative, kept there rather than duplicated per-report).

### 2026-08-27: chunking sweep (W4)

Closes D3 (group size/cap), D4 (overlap), D9 (chunk text) per the plan's fixed decision rule
(markdown-chunking.md W4): per corpus, never averaged; ship the candidate that loses on no
corpus, simplest among those; flat everywhere ships the simplest on the correctness argument.
Apple Silicon, Node 26.7.0. Method: `features/embed.ts`'s one call site
(`chunk(body, {...})`) was edited to each variant's options in turn, `npm run build`, evaluated,
then restored byte-identical (verified by `git diff` against the pre-sweep tree at the end).
`benchmark/eval.mjs` gained `--model`/`--provider`/`--url` flags (defaulting to the prior
hardcoded static config, so nfcorpus's invocation is unchanged) so miracl-zh could run through
the same real `search()` -> `chunk()` path over Ollama's OpenAI-compatible endpoint instead of a
whole-document bake-off. **Harness surprise, load-bearing**: the cache's feature signature
(`chunk:v2`) is a fixed string independent of grouping options, so re-running `eval.mjs` after
only editing `chunk()`'s options and rebuilding silently reused the previous variant's cached
chunks/vectors. Every run below cleared the corpus tree's `.sense` directory first; this is a
gap the chunker's own signature should probably close before it ships. Not fixed here, out of
W4's scope.

Variants: V1 pgc/raw/no-overlap (the wired default) · V2 target/raw (targetTokens 500) · V3
pgc/raw/overlap · V4 pgc/extracted/no-overlap. Chunk-diff checked first, cheaply, with no
embedding at all: `chunk()` called directly over both gate corpora for every option pair.

**V1, V2, and V3 produce byte-identical chunk text on every single document of both gate
corpora** (0/3,633 nfcorpus docs differ, 0/4,000 miracl-zh docs differ). Both corpora are
effectively one paragraph per document (BEIR abstracts, MIRACL passages), so PGC-vs-target
grouping and overlap never get a boundary to disagree over. This is the plan's own
"gate-power" risk bullet, now measured rather than assumed. V4 (extracted text) differs from V1
on a small minority of documents where markup survives in the source: 16/3,633 nfcorpus (0.44%),
10/4,000 miracl-zh (0.25%).

#### nfcorpus (323 queries, `potion-retrieval-32M`, static, test split)

| variant | nDCG@10 | MRR@10 | hit@10 | mean ms/query (bm25/fused/semantic) | chunks | chunks/doc | chars mean/median | tokens mean/median |
|---|---|---|---|---|---|---|---|---|
| 0.16.0 baseline (heading-only, recorded above) | 0.3431 | 0.5553 | 0.7121 | 5.4/5.4/14.5 | — | — | — | — |
| V1 pgc/raw/no-overlap (wired) | 0.3431 | 0.5553 | 0.7121 | 5.4/5.4/20.6 | 3,662 | 1.008 | 1541/1524 | 385/381 |
| V2 target/raw (500) | 0.3431 | 0.5553 | 0.7121 | 5.6/5.5/20.7 | 3,662 | 1.008 | 1541/1524 | 385/381 |
| V3 pgc/raw/overlap | 0.3431 | 0.5553 | 0.7121 | 5.7/5.7/21.6 | 3,662 | 1.008 | 1541/1524 | 385/381 |
| V4 pgc/extracted/no-overlap | 0.3431 | 0.5553 | 0.7121 | 5.7/5.6/20.8 | 3,662 | 1.008 | 1485/1520 | 371/380 |

bm25-only and fused are 0.3234/0.3234 on every row (chunking cannot move a signal that never
touches vectors) and match the recorded baseline digit-for-digit. Paired semantic-vs-fused is
108W/77L z=2.3 on the baseline and on all four variants, digit-for-digit. Every candidate
reproduces 0.16.0 exactly on this corpus.

#### miracl-zh (393 queries, `qwen3-embedding:0.6b` via Ollama's OpenAI-compatible endpoint, test split)

No prior column exists to compare digit-for-digit here: this repo's earlier MIRACL tables
(the per-language and weight-sweep sections in the embedding-model-selection report) score through
`bakeoff`-style raw-SQL BM25 plus a hand-rolled RRF, not through `search()`'s real signals path,
so they are a different measurement. V1 stands as this sweep's own reference point, established
fresh this sitting.

| variant | nDCG@10 | MRR@10 | hit@10 | chunks | chunks/doc | chars mean/median | tokens mean/median |
|---|---|---|---|---|---|---|---|
| V1 pgc/raw/no-overlap (wired) | 0.6165 | 0.5781 | 0.9338 | 4,009 | 1.002 | 179/149 | 155/131 |
| V2 target/raw (500) | 0.6165 | 0.5781 | 0.9338 | 4,009 | 1.002 | 179/149 | 155/131 |
| V3 pgc/raw/overlap | 0.6165 | 0.5781 | 0.9338 | 4,009 | 1.002 | 179/149 | 155/131 |
| V4 pgc/extracted/no-overlap | 0.6167 | 0.5784 | 0.9338 | 4,009 | 1.002 | 172/149 | 152/131 |

bm25-only and fused are 0.5162/0.5162 on every row. Paired semantic-vs-fused: V1/V2/V3 are all
235W/99L z=7.4 (nDCG), 27W/9L z=3.0 (hit), digit-for-digit. V4 is 236W/98L z=7.6, 27W/9L z=3.0:
one query flipped from a loss to a win out of 393, moving nDCG by +0.0002 and MRR by +0.0003.
**Within noise** by any standard this doc applies elsewhere (a single-query flip at n=393).

#### Structural stats on the hub corpus (6,566 files, no relevance judgments; quantifies what the labeled corpora can't measure)

| variant | chunks | chunks/file | chars mean/median | tokens mean/median |
|---|---|---|---|---|
| V1 pgc/raw/no-overlap | 60,040 | 9.144 | 236/104 | 59/26 |
| V2 target/raw (500) | 25,271 | 3.849 | 563/586 | 141/147 |
| V3 pgc/raw/overlap | 60,040 | 9.144 | 308/210 | 77/53 |
| V4 pgc/extracted/no-overlap | 28,421 | 4.329 | 122/74 | 31/19 |

This is where D3/D4/D9 actually have room to differ, and they do: target/500 packs 58% fewer,
much larger chunks than pgc (real notes have more than one paragraph per section, unlike the
gate corpora); overlap keeps pgc's chunk count but grows mean chars 31% from the duplicated
tail; extracted text drops 53% of pgc/raw's chunk count, because blocks that are pure markup
(a bare link, an embed, a tag-only line) strip to empty text under `extracted` and are filtered
out, while `raw` keeps the syntax and counts them as content. None of this is reachable from
nfcorpus or miracl-zh, whose documents are structurally flat; it is exactly the "limited power"
risk the plan named. `chunk-sweep.mjs` was not usable for this comparison as-is: it reports
`parse()`+`extractText()` block counts, which live below the grouping policy entirely and
so cannot distinguish any of these variants; a 0.16.0-equivalent (heading-only) chunk count
was not re-derived either, since that chunker's code no longer exists in the tree and
reconstructing it would mean rewriting removed logic rather than reading it, so it is skipped
here rather than approximated.

#### fever (13,229 queries, `potion-retrieval-32M`, static; winner only, per the plan's "one run, it's the slowest")

| | bm25 | fused | semantic |
|---|---|---|---|
| 0.16.0 baseline (recorded above, 2026-08-27 release gate) | 0.9435 / 0.9508 / 0.9969 | 0.9361 / 0.9381 / 0.9971 | 0.9343 / 0.9352 / 0.9967 |
| V1 (winner, this sweep) | 0.9435 / 0.9508 / 0.9969 | 0.9361 / 0.9381 / 0.9971 | 0.9340 / 0.9347 / 0.9967 |

(each cell is nDCG@10 / MRR@10 / hit@10.) bm25 and fused are digit-identical to the recorded
baseline. Semantic moves nDCG -0.0003 and MRR -0.0005; hit@10 is unchanged. Paired
fused-vs-bm25 is 616W/680L z=-1.8, identical to baseline. Paired semantic-vs-fused is
1044W/968L z=1.7, against the baseline's 1055W/963L z=2.0: same positive shape, just under the
|z|>2 line rather than just over it. **Within noise.** Fever is the one gate corpus with real
paragraph/heading structure (converted Wikipedia, unlike nfcorpus/miracl-zh's flat abstracts),
so this is the one place V1's boundaries can differ at all from the retired heading-only
chunker, and a movement this size (three-in-ten-thousand nDCG, a handful of rank-adjacent ties
across 13,229 queries) is the same order of magnitude as the 1e-4 movements this document
already attributes to unrelated segmentation changes elsewhere, not a regression.

**Decision-rule walk-through.** Every candidate loses on no corpus: nfcorpus is digit-identical
to the recorded 0.16.0 baseline for all four variants, miracl-zh's only movement is a
single-query flip (V4), and fever's confirmation run for the winner moves within the doc's own
established noise band. This is the rule's "flat everywhere" branch, which ships the simplest
candidate on the correctness argument (F1's unbounded chunks, F3's measured truncation) rather
than on a quality delta that was never there to find. Simplest is V1: no overlap (unlike V3),
the paper-faithful policy carrying no extra size knob (unlike V2's `targetTokens`), and the
source text taken verbatim with no extraction transform (unlike V4). V1 wins outright — nothing
beat it on either gate corpus — so no combined variant was measured (D4/D9's "if a non-V1
variant wins, run the combination" clause does not trigger).

**Verdict: D3 = pgc (capped at 2x working size, per W2's ruling), D4 = no overlap, D9 = raw
text.** `features/embed.ts`'s call site (`chunk(body, { text: 'raw' })`) already matches the
winner — it is unchanged by this sweep, confirmed by `git diff` showing zero difference against
the tree's pre-sweep state. Full suite green post-sweep (722 passing) and `tsds validate` clean
(0 errors; the 2 typedoc warnings are W6's pre-existing, unrelated `SIGNAL_NAMES`/
`SignalWeights` items).
