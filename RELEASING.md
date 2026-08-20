# Releasing

Everything that can block a release runs **before** the version bump, and publishing is the last step of all. A regression or a stale doc found after `npm publish` is already shipped: consumers install it, and the only remedy is another release.

1. `npm test` and `npx tsds validate`, both clean. `npm run test:engines` when the release touches anything platform-near (SQLite pragmas, fs, watch): it runs the suite on the oldest supported Node, which is where "works on my machine" breaks.

2. **Regenerate the benchmarks**, still on the previous version number. No release goes out on numbers from an earlier run (see [BENCHMARKING.md](BENCHMARKING.md)):

   ```bash
   node benchmark/compare.mjs                                    # released baseline vs local
   node benchmark/run.mjs . .tmp/cache/obsidian-hub-x2-x2-hub-1  # 13k scale row
   node benchmark/run.mjs . .tmp/cache/obsidian-hub-x4-x4-hub-1  # 26k scale row
   node benchmark/run.mjs . .tmp/cache/stress-stress-1           # shape-cliff guard row
   ```

The stress corpus packs every measured shape cliff into one tree (1MB note, 200 headings/note, 100 links/note, 300 fields; see benchmark/lib/corpus.mjs); its rows moving means a fixed cliff regressed, regardless of how flat the hub rows look.

With no arguments `compare.mjs` benchmarks the version in `package.json` (installed from npm) against this working tree. Because the bump happens after a release, that version is the last release until the moment you bump, so the default is always "the release we shipped vs what is about to ship", with no version typed anywhere. Older columns can be added by naming versions explicitly. Run nothing else on the machine while they run.

3. Read the numbers against the previous column. A row that moved beyond noise blocks the release until it is explained or fixed. Noise looks like: differences under ~10% that disagree in direction between correlated metrics (wall vs in-process), on rows the harness measures once. A real regression moves consistently and grows with tree size, which is what the 13k/26k rows are for. Token counts (`map`, `peek`, `find` row) are contracts, not timings: any growth there is a context-bloat regression regardless of size.

4. Update BENCHMARKING.md: results table, scale table, **capabilities column for the new version**. Write down which movements were judged noise, so the next reader does not re-hunt them.

5. **Reconcile the docs with what actually ships.** Published surfaces drift silently because nothing fails when they do; this step is what catches it. Every new command, flag, config key, and output column belongs in the surface that owns it:

   | surface | owns | audience |
   |---|---|---|
   | `README.md` | what it is, what it costs, every command, config shape | humans and agents deciding whether to adopt, and starting |
   | `package.json` `description` | the README's opening sentence, verbatim | npm search results |
   | `package.json` `keywords` | the terms someone would type into npm to find what sense now does | npm search results |
   | `skills/sense` | querying an existing tree | agents |
   | `skills/sense-setup` | making or restructuring one | agents |
   | `schema.json` | every config key | editors |

The mechanical facts are tested in `test/unit/docs.test.ts`; the rest is a read. For `keywords`: write down the search terms a person looking for this release's new capability would type (a release that added semantic search added `semantic-search`), check each is present, and drop keywords for things sense no longer emphasizes. Keywords are how npm search finds the package, and they only change when capabilities do, so this review belongs to the release that changes them. Form: npm's indexer tokenizes hyphens as word separators (verified empirically 2026-08-15 against the registry search API), so `knowledge-base` matches both "knowledge-base" and "knowledge base" queries, while a closed compound (`knowledgebase`) matches only itself. Always prefer the hyphenated form for multi-word keywords. Re-check every measured claim in the docs against the run from step 2; a number that no longer holds is worse than no number, because the next reader trusts it. Prefer linking BENCHMARKING.md over copying figures that drift.

6. **Verify what actually ships, against what is already published.** The repo is not the package; every check so far ran against the repo. `npm pack --dry-run` and read the file list: everything intended (`dist`, `skills`, `schema.json`), nothing stray. Then a clean-install smoke test: `npm pack`, install the tarball into a temp dir, and on a scratch tree run `sense --version`, `sense init`, `sense map`, `sense search`, one `sense query`. This catches works-in-repo-broken-when-packed failures (a missing file, a path that only resolves in the checkout). Finally compare against the published package (`npm view sensemaking files description keywords engines version`): every difference between it and what is about to ship must be intended, not discovered by a consumer. Comparison beats memory: drift is caught by diffing against what exists, not by remembering what changed.

7. Commit steps 1–6.

8. Maintainer picks the version, then: `npm version <chosen>` → `npm publish` → `git push --follow-tags`. Confirm the tag reached the remote (`git ls-remote --tags origin`): a skipped push leaves a version on npm with no commit or tag behind it, and nothing downstream notices.

9. Tell consumers what changed: dependent trees get their note, and the git tag's release notes carry the consumer-visible changes (new config keys, changed output shapes, bug fixes), the same list the maintainer used to pick the version. Consumers are on the previous version until they upgrade, so guidance written for unreleased behaviour is guidance that fails.

**Docs-only patches take the short path.** When the diff touches nothing but published prose (*.md files, skill text, schema descriptions), steps 2–4 and 6 (benchmarks, their reading, the pack/compare verification) are skipped: text cannot move a number. What remains: `npm test` (the docs tests guard the mechanical facts), the step-5 read of the surfaces the diff touched, then version → publish → push with the tag check. Anything that touches src/, benchmark logic, or dependencies is not a docs-only patch, whatever the diff size.

Benchmark tables in BENCHMARKING.md are pasted from harness output, never hand-typed. `compare.mjs` derives the baseline column's version label from `package.json`, so a hand-written version string in a table is a sign the table didn't come from a run.

**The version is the maintainer's call.** An agent preparing a release states what changed and what a consumer would notice (new config keys, changed output shapes, changed storage classes, bug fixes only) and suggests a bump if asked. It does not choose one, and does not encode a bump policy here.

Two storage formats version themselves, and neither is a judgement call:

- **The cache.** Any change to what reconcile writes: bump `SCHEMA_VERSION` in `src/db.ts`, so existing trees rebuild on first query instead of reading rows written in an older format. Consumers pay one re-crawl (and embed trees re-embed on their next `--semantic`), worth saying in the consumer notes so it doesn't read as a hang.
- **The config file.** A change that makes an existing `sense.config.json` wrong (a renamed or removed key, a changed default, a restructured block) bumps `SUPPORTED_CONFIG_VERSION` in `src/config.ts`, adds a step to `MIGRATIONS` that rewrites the old shape, and extends `version`'s enum in `schema.json`. A purely additive change (a new optional key, a new accepted value shape) leaves every old config valid and does not bump; saved finds are the example: `queries` gained an object form and v2 configs kept working untouched.

Whether or not either version moved, the release verifies both paths on a scratch tree: a config from the oldest supported version still auto-migrates (`sense <any command>` prints the migration line and rewrites the file), and a cache written by the previous release rebuilds rather than erroring. `test/unit/config-version.test.ts` covers the migration chain; the scratch run is what proves it against the packed build.
