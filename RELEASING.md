# Releasing

Everything that can block a release runs **before** the version bump, and publishing is the last step of all. A regression or a stale doc found after `npm publish` is already shipped: consumers install it, and the only remedy is another release.

Subagents dispatched during a release are spawned with `model: sonnet`. Reviews at high or max effort go through the `coding-standards` skill, which keeps the built-in review's fork and its workers on Sonnet whatever the session model. When the session model is costlier than Sonnet, the multi-step steps below (the benchmark write-up, the docs reconcile) are dispatched to subagents rather than run inline; the session keeps the one-command gates and the reading of results.

1. `npm test` and `npx tsds validate`, both clean. `npm run test:engines` when the release touches anything platform-near (SQLite pragmas, fs, watch): it runs the suite on the oldest supported Node, which is where "works on my machine" breaks.

   `test/integration/live.test.ts` is the part CI cannot run: it talks to real endpoints, one gate variable per [INTEGRATIONS.md](INTEGRATIONS.md) row, read from `.env.test` (gitignored). A release that touches `src/embed/` runs it with the file populated, and the rows it verified get that day's date. Unset gates skip silently, so a green `npm test` alone does not mean the live paths ran. Check the count.

   ```
   SENSE_TEST_COHERE_KEY=...                          # cohere row
   SENSE_TEST_OLLAMA_URL=http://localhost:11434/v1    # ollama rows
   SENSE_TEST_OLLAMA_MODEL=qwen3-embedding:0.6b       # optional, this is the default
   SENSE_TEST_OLLAMA_LANGUAGES=en,zh,ja,ru,de         # what that model declares; drives which language cases run
   SENSE_TEST_LMSTUDIO_URL=http://localhost:1234/v1   # same three, LM Studio side; _KEY too if it wants one
   ```

2. **Regenerate the benchmarks**, still on the previous version number, and write the sitting down. No release goes out on numbers from an earlier run (see [BENCHMARKING.md](BENCHMARKING.md)):

   ```bash
   node benchmark/release.mjs   # compare + 13k/26k scale + stress + both quality evals
   ```

   One command on purpose: the gate was a list of manual steps for its first nine releases, and the fever quality eval was skipped by every sitting since 0.6.0 because nothing forced it. Fetches (corpora, npm baselines, the fever wiki dump) cache through `benchmark/lib/cache.mjs`, so only the first run on a machine pays the downloads.

   Save this sitting's output as `benchmark/reports/YYYY-MM-DD-<topic>.md` (today's date, topic naming what it gates, e.g. `release-gate`), with a frontmatter block naming date, package/chunk/schema versions, machine, node, corpora, models, and the headline metrics BENCHMARKING.md's numbers-of-record table tracks. This is a new file per sitting, never an edit to a previous one. The report directory is a queryable history, not a rolling doc. Set the previous terminal report's `superseded_by` to this new file's name, so the chain from the first sitting to the current one stays unbroken.

The stress corpus packs every measured shape cliff into one tree (1MB note, 200 headings/note, 100 links/note, 300 fields; see benchmark/lib/corpus.mjs); its rows moving means a fixed cliff regressed, regardless of how flat the hub rows look.

With no arguments `compare.mjs` benchmarks the version in `package.json` (installed from npm) against this working tree. Because the bump happens after a release, that version is the last release until the moment you bump, so the default is always "the release we shipped vs what is about to ship", with no version typed anywhere. Older columns can be added by naming versions explicitly. Run nothing else on the machine while they run.

3. **Obsidian parity, when the release touches parsing** (tags, links, sections, fences, frontmatter): `node benchmark/oracle.mjs obsidian-hub-b11036f9 .tmp/cache/obsidian-hub-b11036f9` diffs sense's tags table, and `src/chunk`'s block extents (headings, section extents), against Obsidian's own metadata cache, the reference implementation, so drift cannot ship silently. The target is the repo's own pinned benchmark corpus; one-time setup per machine: open that folder in Obsidian via "Open folder as vault" (the registration is path-based and survives `.tmp` regeneration; the `.obsidian/` it writes lives in a throwaway cache dir). The script needs Obsidian running, requires `npm run build` first (block extents import the built dist/esm), and stores nothing. Dump and index live in temp and are deleted. Zero differing files passes for tags/links; for block extents, zero diffs outside the documented representation classes the script itself buckets and prints. Anything else is adjudicated line by line, never averaged away.

4. Read the numbers against the previous column. A row that moved beyond noise blocks the release until it is explained or fixed. Noise looks like: differences under ~10% that disagree in direction between correlated metrics (wall vs in-process), on rows the harness measures once. A real regression moves consistently and grows with tree size, which is what the 13k/26k rows are for. Token counts (`map`, `peek`, `find` row) are contracts, not timings: any growth there is a context-bloat regression regardless of size.

5. Point BENCHMARKING.md's numbers-of-record table at this sitting's report file (step 2), and update the **capabilities column for the new version**. Write down which movements were judged noise, so the next reader does not re-hunt them.

6. **Reconcile the docs with what actually ships.** Published surfaces drift silently because nothing fails when they do; this step is what catches it. Every new command, flag, config key, and output column belongs in the surface that owns it:

   | surface | owns | audience |
   |---|---|---|
   | `README.md` | what it is, what it costs, every command, config shape | humans and agents deciding whether to adopt, and starting |
   | `package.json` `description` | the README's opening sentence, verbatim | npm search results |
   | `package.json` `keywords` | the terms someone would type into npm to find what sense now does | npm search results |
   | `skills/sense` | querying an existing tree | agents |
   | `skills/sense-setup` | making or restructuring one | agents |
   | `schema.json` | every config key | editors |

The mechanical facts are tested in `test/integration/docs.test.ts`; the rest is a read. For `keywords`: write down the search terms a person looking for this release's new capability would type (a release that added semantic search added `semantic-search`), check each is present, and drop keywords for things sense no longer emphasizes. Keywords are how npm search finds the package, and they only change when capabilities do, so this review belongs to the release that changes them. Form: npm's indexer tokenizes hyphens as word separators (verified empirically 2026-08-15 against the registry search API), so `knowledge-base` matches both "knowledge-base" and "knowledge base" queries, while a closed compound (`knowledgebase`) matches only itself. Always prefer the hyphenated form for multi-word keywords. Re-check every measured claim in the docs against the run from step 2; a number that no longer holds is worse than no number, because the next reader trusts it. Prefer linking BENCHMARKING.md over copying figures that drift.

7. Commit steps 1–6, as one commit, or a few when the diff separates naturally (the code change, the benchmark tables). A release is not a trail of incremental work-in-progress commits; if the work accumulated as one, squash before the bump. Messages are short and factual, no Co-Authored-By trailer.

8. Maintainer picks the version, then: `npm version <chosen>` → `npm publish` → `git push --follow-tags`. Confirm the tag reached the remote (`git ls-remote --tags origin`): a skipped push leaves a version on npm with no commit or tag behind it, and nothing downstream notices.

`npm version` leaves HEAD on the release commit, which reads like any other commit in `git log`. Never `--amend` from there, and check `git log -1` before amending at all: rewriting it diverges from the tag and from what npm already shipped. A follow-up fix is a new commit, and the next `npm version` carries it.

9. Tell consumers what changed: dependent trees get their note, and the git tag's release notes carry the consumer-visible changes (new config keys, changed output shapes, bug fixes), the same list the maintainer used to pick the version. Commit messages and release notes are short and factual, and never carry a Co-Authored-By trailer. Consumers are on the previous version until they upgrade, so guidance written for unreleased behaviour is guidance that fails.

**Docs-only patches take the short path.** When the diff touches nothing but published prose (*.md files, skill text, schema descriptions), steps 2–4 (the benchmarks and their reading) are skipped: text cannot move a number. What remains: `npm test` (the docs tests guard the mechanical facts), the step-5 read of the surfaces the diff touched, then version → publish → push with the tag check. Anything that touches src/, benchmark logic, or dependencies is not a docs-only patch, whatever the diff size.

Benchmark tables in `benchmark/reports/` are pasted from harness output, never hand-typed. `compare.mjs` derives the baseline column's version label from `package.json`, so a hand-written version string in a table is a sign the table didn't come from a run.

**The version is the maintainer's call.** An agent preparing a release states what changed and what a consumer would notice (new config keys, changed output shapes, changed storage classes, bug fixes only) and suggests a bump if asked. It does not choose one, and does not encode a bump policy here.

Two storage formats version themselves, and neither is a judgement call:

- **The cache.** Any change to what reconcile writes: bump `SCHEMA_VERSION` in `src/db.ts`, so existing trees rebuild on first query instead of reading rows written in an older format. Consumers pay one re-crawl (and embed trees re-embed on their next `--semantic`), worth saying in the consumer notes so it doesn't read as a hang.
- **The config file.** A change that makes an existing `sense.config.json` wrong (a renamed or removed key, a changed default, a restructured block) bumps `SUPPORTED_CONFIG_VERSION` in `src/config.ts`, adds a step to `MIGRATIONS` that rewrites the old shape, and extends `version`'s enum in `schema.json`. A purely additive change (a new optional key, a new accepted value shape) leaves every old config valid and does not bump; saved finds are the example: `queries` gained an object form and v2 configs kept working untouched.

Whether or not either version moved, the release verifies both paths on a scratch tree: a config from the oldest supported version still auto-migrates (`sense <any command>` prints the migration line and rewrites the file), and a cache written by the previous release rebuilds rather than erroring. `test/unit/config/load.test.ts` covers the migration chain; the scratch run is what proves it against the packed build.
