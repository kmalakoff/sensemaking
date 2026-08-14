# Releasing

Order matters: everything that can block a release runs **before** the version bump, so a
regression stops the release instead of being discovered in a published version.

1. `npm test` and `npx tsds validate` — both clean.
2. **Regenerate the benchmarks** (see [BENCHMARKING.md](BENCHMARKING.md)), still on the
   previous version number:

   ```bash
   node benchmark/compare.mjs obsidian-hub <previous...> <current>   # all columns, one sitting
   node benchmark/run.mjs . .tmp/cache/obsidian-hub-x2-x2-hub-1      # 13k scale row
   node benchmark/run.mjs . .tmp/cache/obsidian-hub-x4-x4-hub-1      # 26k scale row
   ```

   The working tree is measured as the upcoming version: `compare.mjs` installs published
   versions from npm and runs the local checkout for the newest column, so the numbers are
   real before anything ships. Run nothing else on the machine while they run.
3. Read the numbers against the previous column. A row that moved beyond noise blocks the
   release until it is explained or fixed. Noise looks like: differences under ~10% that
   disagree in direction between correlated metrics (wall vs in-process), on rows the
   harness measures once. A real regression moves consistently and grows with tree size —
   which is what the 13k/26k rows are for. Token counts (`map`, `peek`) are contracts, not
   timings: any growth there is a context-bloat regression regardless of size.
4. Update BENCHMARKING.md — results table, scale table, capabilities row for anything new —
   and write down which movements were judged noise, so the next reader does not re-hunt
   them. Commit.
5. `npm version <patch|minor>`, then publish, then `git push --follow-tags`.
6. Tell dependent trees what changed. Consumers are on the previous version until they
   upgrade, so guidance written for unreleased behaviour is guidance that fails.

Version choice, pre-1.0: a new feature, a changed output shape, or a changed storage class
is a minor bump. Cache-affecting changes need `SCHEMA_VERSION` bumped in `src/db.ts` so
existing trees rebuild on first query rather than reading stale rows.
