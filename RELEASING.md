# Releasing

Order matters: everything that can block a release runs **before** the version bump, so a
regression stops the release instead of being discovered in a published version.

1. `npm test` and `npx tsds validate` — both clean.
2. **Regenerate the benchmarks** (see [BENCHMARKING.md](BENCHMARKING.md)), still on the
   previous version number:

   ```bash
   node benchmark/compare.mjs                                    # released baseline vs local
   node benchmark/run.mjs . .tmp/cache/obsidian-hub-x2-x2-hub-1  # 13k scale row
   node benchmark/run.mjs . .tmp/cache/obsidian-hub-x4-x4-hub-1  # 26k scale row
   ```

   With no arguments `compare.mjs` benchmarks the version in `package.json` (installed from
   npm) against this working tree. Because the bump happens after a release, that version is
   the last release until the moment you bump — so the default is always "the release we
   shipped vs what is about to ship", with no version typed anywhere. Older columns can be
   added by naming versions explicitly. Run nothing else on the machine while they run.
3. Read the numbers against the previous column. A row that moved beyond noise blocks the
   release until it is explained or fixed. Noise looks like: differences under ~10% that
   disagree in direction between correlated metrics (wall vs in-process), on rows the
   harness measures once. A real regression moves consistently and grows with tree size —
   which is what the 13k/26k rows are for. Token counts (`map`, `peek`) are contracts, not
   timings: any growth there is a context-bloat regression regardless of size.
4. Update BENCHMARKING.md — results table, scale table, capabilities row for anything new —
   and write down which movements were judged noise, so the next reader does not re-hunt
   them. Commit.
5. Maintainer picks the version; then `npm version <chosen>`, publish, and
   `git push --follow-tags`.
6. Tell dependent trees what changed. Consumers are on the previous version until they
   upgrade, so guidance written for unreleased behaviour is guidance that fails.

**The version is the maintainer's call.** An agent preparing a release states what changed
and what a consumer would notice — new config keys, changed output shapes, changed storage
classes, bug fixes only — and suggests a bump if asked. It does not choose one, and does not
encode a bump policy here.

Cache-affecting changes are separate and not a judgement call: bump `SCHEMA_VERSION` in
`src/db.ts` so existing trees rebuild on first query instead of reading rows written in an
older format.
