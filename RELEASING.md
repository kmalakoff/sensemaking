# Releasing

Everything that can block a release runs **before** the version bump, and publishing is the last step of all. A regression or a stale doc found after the publish is already shipped: consumers install it, and the only remedy is another release.

House-wide release rules live in the `releasing-standards` skill: what an agent never runs, how history is collapsed and agreed, the changelog, and the handoff that ends an agent's part. This file is sense's own gate, which is the part no other package here has.

Subagents dispatched during a release are spawned with `model: sonnet`. Reviews at high or max effort go through the `coding-standards` skill, which keeps the built-in review's fork and its workers on Sonnet whatever the session model. When the session model is costlier than Sonnet, the multi-step items below (the benchmark write-up, the docs reconcile) are dispatched to subagents rather than run inline; the session keeps the one-command gates and the reading of results.

1. **Run the gate.** One command, and it decides what to run from the diff since the last tag:

   ```bash
   npm run benchmark                     # ordinary assessment: selected required stages, report, verdict
   npm run benchmark -- --profile deep   # explicit deep assessment
   npm run benchmark -- --dry-run        # selected stages, reasons, and historical-cost estimate; no measurement
   ```

   `ordinary` is the default assessment. It runs the selected common correctness and matched-input
   current-store work plus full portable NFCorpus on every offered store. `deep` explicitly adds
   portable FEVER on every store, the large scale/stress workloads, and the legacy SQLite OR-bag
   continuity rows. The dry run exposes the profile, selected requirements, reasons, and a
   historical execution estimate before work begins. The ordinary 10–20 minute target is an
   estimate, not a measured promise for this machine or diff.

   **Changed capabilities expand the common gate before it runs.** Common work owed by the diff
   cannot be skipped by a profile or flag. When an ordinary run owes a baseline assessment but no
   changed capability requires fresh retrieval collection, it revalidates retained raw portable
   NFCorpus quality against the current retrieval, model, corpus, query, judgment, and all-store
   identities. Missing or incompatible raw evidence selects fresh portable NFCorpus before work
   starts; a compact report cannot revalidate quality it omitted. A sitting and its report retain
   the profile and effective requirements, and resume refuses an incompatible selection. Native
   diagnostic matrices and historical sweeps are omitted unless explicitly requested; neither
   profile selects them automatically.

   Stages run in order: static checks, functional suites, hub baseline, scale and stress when
   selected, then retrieval quality when selected. Independent benchmark and evidence failures
   accumulate so the final report lists them together. Failed build/test prerequisites prevent
   dependent work unless their identified failure has an existing owner acceptance. Failed artifact
   producers prevent their dependent comparators, even when that producer failure was accepted.
   Store-dump differences and other independent evidence failures remain BLOCK reasons but do not
   stop unrelated collection. Skipped steps name their unmet prerequisites. Run on an otherwise idle
   machine: timing refuses excessive load and has no override. A rerun on unchanged code reuses
   successful work and retries failed or incomplete steps; a changed measured tree requires new
   evidence. No failure disappears merely because later steps ran.

   **The diff picks the common gates; the profile picks the bounded breadth.**
   `benchmark/lib/gates.mjs` maps changed paths to the gates they owe. A change under `src/embed/`
   owes the live endpoint suite and ordinary baseline relevance obligations, not FEVER; a change
   under `src/chunk/` owes the common Obsidian parity and store checks, while deep adds scale. A
   docs-only change owes the tests and nothing else. Known common gates cannot be skipped by a flag,
   and unreadable or unclassified source and dependency changes expand the selection
   conservatively. The explicit deep profile keeps FEVER visible after it was skipped by every
   sitting from 0.6.0 until something forced it.

   The gate runs every owed gate itself, the Obsidian parity check and the `store-dump` A/B included: the parity step opens the vault named by `SENSE_TEST_OBSIDIAN_VAULT`, and the A/B captures the last release from the npm install `compare-versions` already caches, so nothing is checked out or built twice. A step whose prerequisite is genuinely absent on the machine is reported owed-and-unmet rather than skipped quietly.

   `test/integration/live.test.ts` is the part CI cannot run: it talks to real endpoints, one gate variable per [INTEGRATIONS.md](INTEGRATIONS.md) row, read from `.env.test` (gitignored). The gate runs it when the diff owes it, and in that mode a gate this machine owes and lacks fails outright, naming the fix, rather than skipping silently.

   ```
   SENSE_TEST_COHERE_KEY=...                          # cohere row
   SENSE_TEST_OLLAMA_URL=http://localhost:11434/v1    # ollama rows
   SENSE_TEST_OLLAMA_MODEL=qwen3-embedding:0.6b       # optional, this is the default
   SENSE_TEST_OLLAMA_LANGUAGES=en,zh,ja,ru,de         # what that model declares; drives which language cases run
   SENSE_TEST_LMSTUDIO_URL=http://localhost:1234/v1   # same three, LM Studio side; _KEY too if it wants one
   ```

2. **Read the verdict.** PASS or BLOCK, with one generated line per reason. Nothing is retyped: the report is rendered from the sitting's own JSON into `.tmp/sittings/<sitting>/release-gate.{md,json}`, beside the data, and `npm test` fails if a record and its data disagree.

   **The report cites no commit hash.** One reached by rebase or squash is unreachable afterwards,
   and the claim resting on it becomes uncheckable. The report records what survives instead: the
   last tag, the package version, and the changed paths the gate read to decide what was owed.
   Where a claim needs the measured tree to be the shipped one, state the property and how it was
   checked, `git diff --quiet <a> <b> -- src test` for byte-identical `src/` and `test/`.

   A reason states what was measured, never a cause: the row, both values, the band it exceeded, and whether a reversed-order re-run agreed. A wall-clock delta says where a cost is, not what it is. Two attributions made from one on this repo in a single day were both wrong, so settle a cause by removing the mechanism and re-measuring, or by timing it directly, before writing it anywhere.

   What blocks: failed required behavior, invalid required evidence, missing required coverage, an explicit caller bound or quality floor, an approved performance guard, or an unexplained public semantic change. Historical timing, quality, and output observations are WARN findings, including movements beyond a legacy band. A changed workload or missing prior is INFO and starts a new series. The report keeps valid numeric comparisons, invalid readings, and not-compared rows separate.

   Releasing a PASS in step 6 moves the numbers-of-record table in BENCHMARKING.md to this sitting and rewrites `skills/sense-setup/references/store-benchmarks.md` from the same accepted report. A BLOCK, or a sitting never released, leaves both files exactly as they were.

3. **On BLOCK, fix it or accept it.** Fixing it and running again is the ordinary path. An owner may record a decision against an eligible blocking finding in the owner's own words. This never makes invalid evidence comparable or turns missing required coverage into a pass:

   ```bash
   node benchmark/report.mjs --accept <row id | stage reason> --reason "<why this ships>"
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

   The mechanical facts are tested in `test/integration/docs.test.ts`; the rest is a read. The
   keyword review and the npm indexer's hyphen tokenization are in `releasing-standards`.

   **Keep the published surfaces self-contained.** `npm pack --dry-run` is the boundary: a relative
   link from the README or either skill must resolve inside that tarball. Contributor plans,
   benchmark reports, `BENCHMARKING.md`, `DESIGN.md`, and `INTEGRATIONS.md` do not ship. Leave them
   out when the reader does not need them. When a public source is useful, link to its stable web
   page instead of a package-relative path. Keep benchmark method and full evidence in
   `BENCHMARKING.md` and its reports. Store-selection measurements for installed agents belong only
   in the generated `skills/sense-setup/references/store-benchmarks.md`. The README explains the
   choice without carrying release figures.

   **Review the stores as evolving implementations, not fixed product tiers.** The shared commands,
   tables, result shapes, and declared capabilities are the public contract. Preserve them with the
   common capability suite. Implement each contract with the engine's native mechanisms, and
   optimize the native path that owns a measured cost. Do not translate every store into SQLite's
   FTS5 dialect or reduce all stores to the weakest implementation merely to make their internals
   look alike. A slower result on equivalent work is an optimization finding, not a reason to call
   the store unsuitable.

   Document a difference only when it changes a user's decision or query. The useful differences
   are installation and platform cost, file and connection behavior, supported search grammar,
   raw SQL dialect and extensions, interoperability, and performance or scale measured on a named
   workload. Keep three kinds of claim separate:

   1. what the upstream engine and its ecosystem can do;
   2. what the current Sense adapter exposes;
   3. what the current Sense benchmark measured.

   For example, DuckDB closely follows PostgreSQL SQL while retaining documented differences and
   its own extensions. It supports analytical and larger-than-memory workloads, and MotherDuck can
   add local/cloud hybrid workflows. Those are valid reasons to choose the DuckDB file even when a
   particular Sense timing is slower. Sense itself currently creates a local cache and does not
   connect it to MotherDuck. Likewise, the Turso Database engine is a fast-moving Rust rewrite with
   async I/O, concurrent writes, and a separate sync SDK, while the current Sense adapter opens one
   local file and serializes Sense commands against it. Upstream capabilities become Sense
   capabilities only after the adapter exposes and tests them.

   **Check upstream movement during every release.** Record the installed versions, compare the two
   optional bindings with the current registry releases, and record the SQLite version in each Node
   runtime used by the gate:

   ```bash
   npm ls @duckdb/node-api @tursodatabase/database
   npm view @duckdb/node-api version
   npm view @tursodatabase/database version
   node -p "JSON.stringify({ node: process.version, sqlite: process.versions.sqlite ?? null })"
   ```

   A newer upstream version starts a review; it is not an automatic dependency update or a new
   performance claim. Read the official release notes and current docs, then test the APIs and
   experimental features Sense uses. For Turso this includes index methods, Tantivy behavior,
   transactions, connection lifetime, sync, encryption, and concurrent-write support. For DuckDB
   it includes the Node binding, database-format compatibility, FTS extension behavior, connection
   coordination, SQL changes, and larger-than-memory behavior. When Sense's minimum Node version
   changes, also review the official `node:sqlite` docs and release notes for module stability,
   bundled SQLite version, FTS5, WAL, and function-registration changes. Do not predict a Node and
   Turso convergence; change the guidance only if Node or Turso publishes an implementation change
   and the adapter verifies its consequence.

   The upstream review uses primary sources: [DuckDB SQL](https://duckdb.org/docs/current/sql/introduction),
   [DuckDB performance](https://duckdb.org/docs/current/guides/performance/how_to_tune_workloads),
   [MotherDuck hybrid execution](https://motherduck.com/research/motherduck-duckdb-in-the-cloud-and-in-the-client/),
   [Turso SDK selection](https://docs.turso.tech/sdk/introduction),
   [Turso releases](https://github.com/tursodatabase/turso/releases), and
   [Node's SQLite API](https://nodejs.org/api/sqlite.html). Upstream marketing can identify a path
   to investigate; implementation inspection, shared capability tests, and a representative Sense
   measurement establish the guidance.

   Finish the read from the customer's path. The README gives a short, neutral choice and gets a new
   user to a successful command. `skills/sense-setup` owns selection trade-offs and the dated
   benchmark summary. `skills/sense` owns store-specific SQL and search behavior after a tree exists.
   Remove stale claims even when the code did not change: upstream releases can turn today's
   limitation into tomorrow's optimization opportunity.

5. Ask the maintainer which version this is going out as, write the CHANGELOG entry under that heading, and commit steps 1-4 per `releasing-standards`. A sitting usually separates into the code change and the benchmark tables; the grouping is proposed and agreed before anything is rewritten, and it is collapsed before the bump.

6. With the version named, name the sitting's report for it. This copies it to `benchmark/reports/<date>-<version>-release-gate.{md,json}`, updates BENCHMARKING.md, and generates the shipped store summary from the same data. It measures nothing:

   ```bash
   node benchmark/report.mjs --release <chosen>
   ```

   Then the maintainer's own step, and an agent's part has ended before it: `tsds publish <chosen>`, which reinstalls from the lockfile, runs the tests, bumps the version and publishes in one command. Then `git push --follow-tags`, and confirm the tag reached the remote (`git ls-remote --tags origin`): a skipped push leaves a version on npm with no commit or tag behind it, and nothing downstream notices.

7. Tell consumers what changed: dependent trees get their note, and the git tag's release notes carry the same consumer-visible list as the CHANGELOG entry, which is what the maintainer picked the version from.

**Docs-only patches take the short path**, and the gate takes it for you: a diff touching nothing but published prose owes the static checks and `npm test`, nothing more, because text cannot move a number. What remains: `npm test` (the docs tests guard the mechanical facts), the step-4 read of the surfaces the diff touched, then `tsds publish` and the push with the tag check. Anything that touches src/, benchmark logic, or dependencies is not a docs-only patch, whatever the diff size.

Reports in `benchmark/reports/` are generated from the sitting's own JSON, never written by hand, and `npm test` fails if a report and its data disagree. A release JSON is a compact export: it retains the identities and readings needed for later compatible comparisons, while raw evidence stays in its named sitting and is listed by canonical hash and byte count. It cannot revalidate omitted raw evidence. The markdown of a past report is never edited either: a dated report records what was true that day.

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
