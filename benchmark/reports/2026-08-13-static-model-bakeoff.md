---
date: 2026-08-13
title: static-model bake-off (semantic-search-design.md, sequence step 2)
machine: macOS arm64
node: '26'
corpora:
  - nfcorpus
models:
  - minishlab/potion-retrieval-32M@6fc8051f
nfcorpus_bm25vec_f32_512_ndcg10: 0.3451
nfcorpus_bm25vec_f32_512_hit10: 0.7090
---

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
