---
date: 2026-08-27
title: release gates vs 0.15.4
package_version: 0.16.0
machine: Apple Silicon
node: '26.7.0'
corpora:
  - nfcorpus
  - fever
superseded_by: 2026-08-28-w8-release-gate-regeneration.md
---

### 2026-08-27: release gates

`compare.mjs` vs 0.15.4: every row within same-sitting noise (wall deltas
6-9 ms; in-process cold build 1460 -> 1435 ms; token contracts flat at
~71/~496/~581). The provider architecture, weighted signals, lazy fetch,
language fit, and sidecar routing cost nothing measurable on the performance
surface. Retrieval gates: nfcorpus digit-identical throughout the cycle;
fever regenerated with a 1e-4 attributed movement (see its section).
