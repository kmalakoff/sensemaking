---
date: 2026-08-27
title: embedding model selection (W8)
machine: Apple Silicon
node: '26.7.0'
corpora:
  - nfcorpus
  - miracl-zh
  - miracl-ja
  - miracl-ru
  - miracl-de
models:
  - minishlab/potion-retrieval-32M@6fc8051f
  - minishlab/potion-base-8M@bf8b0566
  - granite-embedding:30m
  - qwen3-embedding:0.6b
nfcorpus_granite30m_bm25vec_native_ndcg10: 0.3653
nfcorpus_granite30m_bm25vec_native_hit10: 0.7399
nfcorpus_qwen3_bm25vec_native_hit10: 0.7523
miraclzh_qwen3_cosine_int8_ndcg10: 0.7324
---

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
