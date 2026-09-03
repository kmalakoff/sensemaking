# Releasing

Everything that can block a release runs **before** the version bump, and publishing is the last step of all. A regression or a stale doc found after `npm publish` is already shipped: consumers install it, and the only remedy is another release.

Subagents dispatched during a release are spawned with `model: sonnet`. Reviews at high or max effort go through the `coding-standards` skill, which keeps the built-in review's fork and its workers on Sonnet whatever the session model. When the session model is costlier than Sonnet, the multi-step items below (the benchmark write-up, the docs reconcile) are dispatched to subagents rather than run inline; the session keeps the one-command gates and the reading of results.

1. **Run the gate.** One command, and it decides what to run from the diff since the last tag:

   ```bash
   npm run benchmark              # runs the owed stages, writes the report, prints the verdict
   npm run benchmark -- --dry-run # what it would run, without measuring
   ```

   Stages run in order and a failing one stops the run: static checks, then the functional suites, then the hub baseline, then scale and stress, then retrieval quality. A broken build is never benchmarked, and a basic regression is not paid for at 26k. Run it on a machine that is otherwise idle: it refuses to start a timing stage when the one-minute load is above half the core count, and there is no override. Stop whatever else is running and run the gate again; the sitting resumes where it stopped, so a refusal costs nothing.

   **The diff picks the gates, not the person running it.** `benchmark/lib/gates.mjs` maps changed paths to the gates they owe: a change under `src/embed/` owes the live endpoint suite and the fever eval, a change under `src/chunk/` owes the Obsidian parity gate, a docs-only change owes the tests and nothing else. A gate the map owes cannot be skipped by a flag. This exists because the fever eval was skipped by every sitting from 0.6.0 until something forced it.

   The gate runs every owed gate itself, the Obsidian parity check and the `store-dump` A/B included: the parity step opens the vault named by `SENSE_TEST_OBSIDIAN_VAULT`, and the A/B captures the last release from the npm install `compare-versions` already caches, so nothing is checked out or built twice. A step whose prerequisite is genuinely absent on the machine is reported owed-and-unmet rather than skipped quietly.

   `test/integration/live.test.ts` is the part CI cannot run: it talks to real endpoints, one gate variable per [INTEGRATIONS.md](INTEGRATIONS.md) row, read from `.env.test` (gitignored). The gate runs it when the diff owes it, and in that mode a gate this machine owes and lacks fails outright, naming the fix, rather than skipping silently.

   ```
   SENSE_TEST_COHERE_KEY=...                          # cohere row
   SENSE_TEST_OLLAMA_URL=http://localhost:11434/v1    # ollama rows
   SENSE_TEST_OLLAMA_MODEL=qwen3-embedding:0.6b       # optional, this is the default
   SENSE_TEST_OLLAMA_LANGUAGES=en,zh,ja,ru,de         # what that model declares; drives which language cases run
   SENSE_TEST_LMSTUDIO_URL=http://localhost:1234/v1   # same three, LM Studio side; _KEY too if it wants one
   ```

2. **Read the verdict.** PASS or BLOCK, with one generated line per reason. Nothing is retyped: the report is rendered from the sitting's own JSON into `benchmark/reports/YYYY-MM-DD-release-gate.{md,json}`, and `npm test` fails if a report and its data disagree.

   **The report cites no commit hash.** One reached by rebase or squash is unreachable afterwards,
   and the claim resting on it becomes uncheckable. The report records what survives instead: the
   last tag, the package version, and the changed paths the gate read to decide what was owed.
   Where a claim needs the measured tree to be the shipped one, state the property and how it was
   checked, `git diff --quiet <a> <b> -- src test` for byte-identical `src/` and `test/`.

   A reason states what was measured, never a cause: the row, both values, the band it exceeded, and whether a reversed-order re-run agreed. A wall-clock delta says where a cost is, not what it is. Two attributions made from one on this repo in a single day were both wrong, so settle a cause by removing the mechanism and re-measuring, or by timing it directly, before writing it anywhere.

   What blocks: a token contract that moved at all, a quality metric that fell, a stress or scale row beyond its band, a store battery that failed, a timing row beyond its band that a reversed-order re-run agreed with. What does not: anything inside its band, and the rows too noisy to gate, which say so.

   On PASS the numbers-of-record table in BENCHMARKING.md moves to this sitting. On BLOCK it is left exactly as it was, so a blocked sitting's numbers never become the official ones. The run says which happened.

3. **On BLOCK, fix it or accept it.** Fixing it and running again is the ordinary path. Where the movement is understood and the owner decides to ship anyway, record that decision against the row in the owner's own words and run the gate again:

   ```bash
   node benchmark/report.mjs --accept <row id> --reason "<why this ships>"
   ```

   The reason is required and cannot be blank: an override with nothing written in it records no decision. It appears in the report beside the row, and `npm test` fails on a report carrying an accepted row without one. An agent never runs this. The version is the maintainer's call and so is this.

4. **Reconcile the docs with what actually ships.** Published surfaces drift silently because nothing fails when they do; this step is what catches it. Every new command, flag, config key, and output column belongs in the surface that owns it:

   | surface | owns | audience |
   |---|---|---|
   | `README.md` | what it is, what it costs, every command, config shape | humans and agents deciding whether to adopt, and starting |
   | `package.json` `description` | the README's opening sentence, verbatim | npm search results |
   | `package.json` `keywords` | the terms someone would type into npm to find what sense now does | npm search results |
   | `skills/sense` | querying an existing tree | agents |
   | `skills/sense-setup` | making or restructuring one | agents |
   | `schema.json` | every config key | editors |

The mechanical facts are tested in `test/integration/docs.test.ts`; the rest is a read. For `keywords`: write down the search terms a person looking for this release's new capability would type (a release that added semantic search added `semantic-search`), check each is present, and drop keywords for things sense no longer emphasizes. Keywords are how npm search finds the package, and they only change when capabilities do, so this review belongs to the release that changes them. Form: npm's indexer tokenizes hyphens as word separators (verified empirically 2026-08-15 against the registry search API), so `knowledge-base` matches both "knowledge-base" and "knowledge base" queries, while a closed compound (`knowledgebase`) matches only itself. Always prefer the hyphenated form for multi-word keywords. Re-check every measured claim in the docs against the run from step 2; a number that no longer holds is worse than no number, because the next reader trusts it. Prefer linking BENCHMARKING.md over copying figures that drift.

5. Commit steps 1-4, as one commit, or a few when the diff separates naturally (the code change, the benchmark tables). A release is not a trail of incremental work-in-progress commits; if the work accumulated as one, squash before the bump. Messages are short and factual, no Co-Authored-By trailer. Never start a pre-bump subject with the version number: the bump commit is a bare version number, so a subject leading with one reads as the release having already happened. Name the work and carry the version inside it, `Benchmarking for 0.19.2 release: full battery on all three stores`.

6. Maintainer picks the version. Stamp it on the sitting's report first, which re-renders from the same data and measures nothing:

   ```bash
   node benchmark/report.mjs --release <chosen>
   ```

   Then: `npm version <chosen>` → `npm publish` → `git push --follow-tags`. Confirm the tag reached the remote (`git ls-remote --tags origin`): a skipped push leaves a version on npm with no commit or tag behind it, and nothing downstream notices.

Run the three as separate commands, never chained with `&&`: a chain publishes with no point to stop and read what is about to ship.

`npm version` owns the version commit. Never hand-write one, and never fold the bump into the work commit: the bump is subject-only (the bare version number) and touches `package.json` and `package-lock.json` and nothing else, which is what every release in `git log` looks like. Squashing the work into minimal commits happens in step 7, before the bump, because the message is cheap to fix then and expensive after: rewriting anything below a published tag means deleting and recreating that tag.

`npm version` leaves HEAD on the release commit, which reads like any other commit in `git log`. Never `--amend` from there, and check `git log -1` before amending at all: rewriting it diverges from the tag and from what npm already shipped. A follow-up fix is a new commit, and the next `npm version` carries it.

7. Tell consumers what changed: dependent trees get their note, and the git tag's release notes carry the consumer-visible changes (new config keys, changed output shapes, bug fixes), the same list the maintainer used to pick the version. Commit messages and release notes are short and factual, and never carry a Co-Authored-By trailer. Consumers are on the previous version until they upgrade, so guidance written for unreleased behaviour is guidance that fails.

**Docs-only patches take the short path**, and the gate takes it for you: a diff touching nothing but published prose owes the static checks and `npm test`, nothing more, because text cannot move a number. What remains: `npm test` (the docs tests guard the mechanical facts), the step-5 read of the surfaces the diff touched, then version → publish → push with the tag check. Anything that touches src/, benchmark logic, or dependencies is not a docs-only patch, whatever the diff size.

Reports in `benchmark/reports/` are generated from the sitting's own JSON, never written by hand, and `npm test` fails if a report and its data disagree. The markdown of a past report is never edited either: a dated report records what was true that day.

**The version is the maintainer's call.** An agent preparing a release states what changed and what a consumer would notice (new config keys, changed output shapes, changed storage classes, bug fixes only) and suggests a bump if asked. It does not choose one, and does not encode a bump policy here.

Two storage formats version themselves, and neither is a judgement call:

- **The cache.** Any change to what reconcile writes: bump `SCHEMA_VERSION` in each store's `open.ts`, so existing trees rebuild on first query instead of reading rows written in an older format. Consumers pay one re-crawl (and embed trees re-embed on their next vector search), worth saying in the consumer notes so it doesn't read as a hang.
- **The config file.** A change that makes an existing `sense.config.json` wrong (a renamed or removed key, a changed default, a restructured block) bumps `SUPPORTED_CONFIG_VERSION` in `src/config/types.ts`, adds a step to `MIGRATIONS` that rewrites the old shape, and extends `version`'s enum in `schema.json`.

  **One sanctioned exception: a key that was never portable fails loudly instead of migrating.**
  `content.tokenize` was deleted in 0.21.0 without a migration, on the owner's decision, and that is
  correct rather than an oversight. It passed a raw SQLite FTS5 tokenizer string straight into the
  DDL, so `trigram` did something on sqlite and nothing at all on duckdb or turso. It never worked
  as a portable setting, and every outcome it selected is now automatic on all three stores.
  Migrating it silently would delete a choice someone made deliberately without
  telling them, which is the `no-silent-modes` failure inverted. A tree carrying the key fails to
  load with a message naming the removal; removing the block rebuilds the index under the current
  tokenizer, verified end to end on a v0.20.0 cache. Migration remains the rule for a key that did
  what it said. A purely additive change (a new optional key, a new accepted value shape) leaves every old config valid and does not bump; saved queries are the example: `queries` gained an object form and v2 configs kept working untouched.

Whether or not either version moved, the release verifies both paths on a scratch tree: a config from the oldest supported version still auto-migrates (`sense <any command>` prints the migration line and rewrites the file), and a cache written by the previous release rebuilds rather than erroring. `test/unit/config/load.test.ts` covers the migration chain; the scratch run is what proves it against the packed build.
