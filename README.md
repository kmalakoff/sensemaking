# sensemaking

Search and query a directory of Markdown notes from the command line. `sense` indexes frontmatter, prose and links in a local database. It can also combine word matches with links and semantic similarity.

Results contain file paths, snippets and line ranges. A person or agent can inspect the relevant passages without loading every note. No server or daemon is required; the default CLI query performs the incremental preparation it needs.

## Problem

Markdown notes accumulate: research, decisions, meeting notes, agent output. Past a few dozen, finding the ones relevant to what you're doing means grepping or reading whole folders into context. The structure that makes notes navigable (frontmatter, wikilinks, headings) is exactly what a query needs, but nothing exposes it as a query surface.

`sense` indexes all of it into a local database (SQLite by default, or the experimental DuckDB store, see Config). By default, CLI queries reconcile the capabilities they need before reading; `--no-build` instead reads the last completed indexed generation without scanning live files. Nothing has to be running.

## Quick start

```bash
npm install -g sensemaking
cd your-notes && sense init
sense download          # optional prefetch; build or the first default vector search fetches it otherwise
```

Requires Node.js 22.20 or newer. The default store uses Node's built-in SQLite.

```bash
sense map                                        # orient: fields, hub notes, recent changes
sense search "revenue OR earnings" --k 10        # locate: words + links + meaning, one ranked list
sense peek notes/q3-report.md                    # structure: outline + links, before reading
sense sql "SELECT path FROM frontmatter WHERE has(tags, ?)" urgent
```

A search result identifies the matching note, the evidence used to rank it and the relevant line range:

```text
path                 snippets                                  via    score   lines
pricing-decision.md  …«pricing» decision … renewal «price»…    match  0.0167  L4-7
```

The row is illustrative. Actual paths, snippets and scores depend on the notes and configured search signals.

## Library usage

Install the package locally in your Node.js project for imports; the global CLI installation above does not provide a project dependency:

```bash
npm install sensemaking
```

Start with an existing `your-notes/sense.config.json` pointing at your Markdown tree, created with `sense init` or written as shown under [Config](#config). `build` prepares every configured capability. Your embedding configuration governs model downloads and provider requests, including any service costs; see [Providers](#providers).

Save this as `search-notes.mjs` in your project and run `node search-notes.mjs`. Adjust the config path and search terms for your notes:

```js
import { loadConfig, build, open, search } from 'sensemaking';

const config = loadConfig('./your-notes/sense.config.json');
await build(config);
const { store, cfg } = await open(config, { build: false });
try {
  const results = await search(store, cfg, 'pricing', { k: 5 });
  console.log(JSON.stringify(results, null, 2));
} finally {
  await store.close();
}
```

The handle uses the completed index prepared by `build`; the example awaits the search before closing it.

## What sense indexes

The [Sense terminology reference](skills/sense/references/terminology.md) defines notes, snippets, sections, chunks and links. A section is a span of the note; `peek` returns its description, not its prose. The ordered section descriptions form the outline.

Every file becomes rows in these tables, plus whatever an enabled feature adds of its own:

| table | holds | for |
|---|---|---|
| `frontmatter` | one column per key, plus `path`, `_mtime`, `_size`, `_rank`, `_parse_error` | filtering |
| `content` | `title`, `summary`, `text`, `path` | text search and ranking |
| `links` | `src`, `target` as written, `dst` resolved (`NULL` = unresolved link, including attachments and targets outside the index) | graph |
| `tags` | `path`, `tag`; frontmatter and inline `#tags` merged and deduplicated, nested tags stored full | tag filters |
| `sections` | heading, `level`, `start_line`, `end_line`, `tokens` estimate | structure |
| `preset_files` | `path`, `preset` | which presets cover which files; `sql --preset` binds these as a `scope` table to join, since `sql` is otherwise index-wide |

Results are references (path, title, summary, snippets), never file contents. Reading happens afterward through the filesystem, scoped to the line ranges `peek` returns. This is the [just-in-time context pattern](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents): the agent holds lightweight identifiers and loads payloads only when needed.

`map` has fixed-size output, a `search` row is tens of tokens, and a `peek` stays flat however large the note is. What it saves over reading grows with the file; a small note is cheaper to read whole.

```sql
-- filter and search compose in one query
SELECT f.path, content.title, snippet(content, -1, '«', '»', '…', 10) AS snippet
FROM frontmatter f JOIN content ON content.path = f.path
WHERE f.status = 'active' AND content MATCH 'revenue'
ORDER BY bm25(content, 10.0, 5.0, 1.0) LIMIT 10
```

## Commands

| command | does |
|---|---|
| `build [--force]` | incrementally update the derived index and prepare every configured search capability; `--force` recreates only `.sense/` |
| `map [--preset name] [--include glob] [--exclude glob] [--no-exclude] [--where "<sql>"]` | doc count, frontmatter field coverage, top hubs by link rank, recent changes; hub/recent limits use bytewise path order on ties |
| `search "<text>" [--preset name] [--include glob] [--exclude glob] [--no-exclude] [--where "<sql>"] [--k n] [--snippet-char-limit n] [--snippet-count-limit n] [--explain]` | words + links + vectors, one fused ranked list; `via` labels each row's evidence. `--k` bounds notes returned, `--snippet-char-limit` (default 80) each passage, `--snippet-count-limit` (default 1) passages per note. `--explain` adds each participating signal's ranking contribution |
| `peek <path> [--preset name] [--include glob] [--exclude glob] [--no-exclude] [--where "<sql>"] [--section-count-limit n] [--link-count-limit n]` | frontmatter, section descriptions (`[L143-162, ~380t]`), outbound links, backlinks and unresolved links; `--section-count-limit` bounds section descriptions, and `--link-count-limit` bounds each link group independently (both default 20), with totals before truncation |
| `path <a> <b> [--max-depth n] [--preset name] [--include glob] [--exclude glob] [--no-exclude] [--where "<sql>"]` | shortest link chain between two notes, or none within the bound |
| `related <note> [--k n] [--preset name] [--include glob] [--exclude glob] [--no-exclude] [--where "<sql>"]` | notes similar in meaning that `<note>` does not yet link to; reads vectors, so semantic-search cost |
| `sql "<statement>" [params...] [--preset name]` | ad-hoc SQL over all the tables; `?` binds positional args. Index-wide by default; `--preset` binds the preset's paths as a `scope` table the statement joins |
| `<name> [params...]` | run a query saved in the config; `--list` names them |
| `init` | write a starter `sense.config.json` |
| `status` | index location, doc count, per-preset coverage, watcher heartbeat |
| `download` | prefetch the embedding model named in the config; build, watch, or a default CLI vector query fetches it when needed otherwise |
| `watch` | keep the index warm in the background (optional; see [watch coordination](https://github.com/kmalakoff/sensemaking/blob/master/DESIGN.md#watch-coordination)) |

Scope flags select from indexed notes; presets are not a security boundary. `peek` rejects an exact path outside the selected scope before trying a basename, resolves a basename only within that scope, and limits resolved outbound links and backlinks to it; unresolved targets remain as written. `path` resolves both endpoints across the indexed tree and applies scope to intermediate notes. `related` resolves its seed across the indexed tree and applies scope to result candidates.

Query commands use the config's `"build": true` default to update the index first and prepare only what that operation needs. Core map, peek, path and SQL work do not prepare vectors. Set `"build": false` for a manual-build or watch workflow, or add `--no-build` for one query. These read the last completed generation without scanning source files or repairing missing readiness; they fail with a `sense build` instruction when the requested capability is not ready. This disables Sense index maintenance, not database access or arbitrary SQL.

The completed generation stores the exact decoded source used for indexed snippets. A no-build query reads those stored sources and checks readiness for the capabilities it requests; it does not hydrate from newer live files. Public `search`, `mapTree`, `peek`, `findPath`, and `relatedNotes` calls assemble each result inside one committed database snapshot. Search completes provider and model preparation before its final snapshot and rejects an incomplete generation or one built for different feature settings instead of mixing generations. A default query incrementally scans the configured tree for the capabilities it needs; vector preparation is limited to its eligible scope. `sense build` prepares every configured capability, and `sense watch` keeps them prepared as changes arrive.

Explicit `sense build` and `sense watch` prepare the index regardless of the config's `build` default. Watch builds before reporting ready, then processes edits; with SQLite, a no-build query can read the previous generation while an edit is being processed. DuckDB permits concurrent cross-process no-build readers only while every handle is observational and read-only; a build or watcher opens the cache read-write and excludes every other process. Turso no-build queries still require a query-capable, exclusive handle. Native contenders wait within a bounded lock budget, then raise `STORE_BUSY`, as described under Store choice. Library callers choose preparation separately at `open`: `open(config)` prepares every configured capability, and `open(config, { build: false })` opens existing compatible state. A build-enabled open repairs incomplete feature state and replaces an incompatible derived cache format; a no-build open reports the required build without rebuilding or repairing the Sense index. The config's `build` setting controls CLI queries only. `build(config, { force: true })` recreates only the derived index. Public `search`, `mapTree`, `peek`, `findPath`, and `relatedNotes` calls on one retained `Store` serialize with one another. Await those calls before running raw SQL, starting a transaction, or closing the handle.

The root `search(store, config, terms, { signal })`, `open(config, { signal })`, and `build(config, { signal })` APIs accept an `AbortSignal`. Cancellation stops supported provider I/O and is checked between phases; synchronous native SQL or CPU work and resource cleanup finish before the promise settles. Cancellation checks preserve `signal.reason`, but a cleanup failure can surface instead or be combined with it in an `AggregateError`.

`search` runs one text through every engine its scope has: FTS5 word match (BM25-ranked, bare words AND-join, operators are yours on `sqlite`; on `duckdb` and `turso` the FTS5 operators are a named error, see Config), a personalized-PageRank walk over the link graph, and vector similarity, fused into one list. `via` labels each row's evidence (`match`, `link`, `vector`, combinations). Within the vector signal, candidates rank by the true cosine against the best-matching canonical chunk before `similarity` is rounded to three decimals for display; a zero-direction vector has similarity `0`, exact cosine ties use bytewise path order, and equal-scoring chunks choose the earliest authored chunk. The public search list ranks the combined word, link, and vector candidates by fused reciprocal-rank score. `lines` identifies a section or embedding chunk's line range in the indexed note. A `vector`-only row has vector evidence rather than a word match; it is not proof that the query words are absent. `--preset` picks a named settings bundle from the config, `--where` filters on frontmatter. `--format json` on any reporting command returns structured output, and `--format csv` writes the row-returning commands one row per line, for redirecting a large result to a file instead of into context; `--version` and `--help` do what they say.

Search rows carry `snippets: string[]`. Each passage is generated around the matched words, marked with `«»`, and normally limited to 80 characters by default. A whole matched word is preserved, so a passage can exceed that limit when the word is longer. `--snippet-count-limit` returns more non-overlapping passages from a note, in document order. Link- and vector-only rows have `snippets: []`.

Use `search --explain --format json` to inspect the returned notes' word, link and vector contributions without changing their ranking. Each `explanation` entry contains the signal, its one-based rank, configured weight and unrounded contribution. This explains the returned candidates, not why an absent note was excluded. Library callers use `search(store, cfg, terms, { explain: true })`. For longer or shorter note outlines and link lists, use `peek(store, cfg, path, { sectionCountLimit: 40, linkCountLimit: 10 })` or the CLI's `--section-count-limit` and `--link-count-limit`. Each limit defaults to 20, must be a positive safe integer and does not change scope.

Lexical words are case- and accent-insensitive. SQLite and DuckDB use their native English stem tokenizers; Turso's native Tantivy index has no stem tokenizer in the supported release, so it applies the shared Porter normalization to a derived field before native indexing. In every store, `run`, `running`, and `runs` match the same authored notes, while authored bytes are never rewritten. Quoted phrases require adjacent words, with punctuation treated as a separator, and punctuation-only input returns no lexical rows. SQLite's native caret and `NEAR(...)` expressions over unspaced text use original FTS5 tokens rather than sidecar substring semantics; use an ordinary quoted search when substring findability matters, at the cost of positional filtering.

## Config

`sense init` writes `sense.config.json`; discovery walks up from cwd like git (`--config <path>` overrides). A config normally indexes its own directory. Set optional top-level `root` to keep configuration and cache state elsewhere: relative roots resolve from the config directory, never from the invocation cwd. Globs and stored `path` values are relative to that root; `.sense/` remains beside the config, so separate consumers can index one vault with separate presets, queries, and caches.

```json
{
  "$schema": "https://unpkg.com/sensemaking/schema.json",
  "version": 6,
  "build": true,
  "presets": {
    "default": { "include": ["**/*.md"], "k": 10 },
    "raw":     { "include": ["raw/**/*.md"], "k": 5 }
  },
  "embed": { "model": "minishlab/potion-retrieval-32M", "provider": "static" },
  "queries": {
    "dead-links": { "sql": "SELECT src, target FROM links WHERE dst IS NULL" },
    "by-tag":     { "sql": "SELECT path, title FROM frontmatter WHERE has(tags, ?) ORDER BY path" },
    "hot":        { "search": "pricing OR billing", "preset": "raw" }
  }
}
```

| key | holds |
|---|---|
| `build` | CLI query-time build default, `true`. Set `false` to query the existing index maintained by explicit `build` or `watch`; `--no-build` overrides `true` for one query. |
| `root` | optional markdown-tree path. Relative to the config directory; omitted means that directory. Preset globs, filesystem reads, watcher events, and indexed `path` values use this root. `.sense/` state stays beside the config. Changing it rebuilds the index. |
| `presets` | named bundles of `include`/`exclude` globs, `k` (result count), `signals` (which engines this scope searches with, `words`, `links`, `vectors`; every signal whose prerequisites hold, unless the preset lists them exhaustively), `where` (a standing SQL filter). A file is indexed if any preset includes it, embedded if a model is named and some covering preset's `signals` include `vectors`; `status` shows each preset's coverage. |
| `embed` | the model vectors are built with. Naming one gives the tree vectors; omitting the block means none at all, whatever the presets say. `sense download` fetches it. |
| `store` | `sqlite` by default, or the experimental `duckdb` and `turso`. Each engine uses its own cache file, so changing this setting rebuilds the index. |
| `queries` | entries runnable as `sense <name>`, each naming the verb it runs: `{ sql }` for SQL (`?` binds positional args) or `{ search }` for a ranked search with its settings baked in, so `sense hot` needs no flags. Running an entry validates it: a typo'd column errors and exits nonzero, and a parameterised entry validates with any argument, since preparing precedes binding. |
| `version` | schema version; older configs auto-migrate on load, noted on stderr. |

Bare commands use the `default` preset; `--preset` names another; flags override single fields. Editing a preset rebuilds the cache and says which preset caused it.

### Store choice

Choose `sqlite` for the smallest setup, full FTS5 query syntax, and concurrent Sense commands. Choose `duckdb` when the cache should participate in DuckDB analytical work over large datasets or in local/cloud workflows. Choose `turso` for its embedded Rust engine and Tantivy text index. The DuckDB and Turso adapters are experimental and install their native package on first use.

The commands and table names are shared. Raw SQL still follows the selected engine's dialect, and advanced FTS5 operators only work on `sqlite`. Separate DuckDB processes may coexist only when every handle is observational and read-only. A DuckDB build-enabled open or watcher is read-write and excludes all other processes. Turso's observational path remains query-capable, so any Turso handle excludes other processes. Sense waits within a bounded lock budget for exclusive native access, then raises `STORE_BUSY`; neither adapter promises writer/reader coexistence. Public commands on one retained `Store` serialize separately, as described above.

Vectors need a model. Naming a Hugging Face id in `embed.model` is consent to fetch it when `sense build`, `sense watch`, or a default CLI vector query first prepares vectors, with progress on stderr, into `~/.sense/models` (huggingface_hub's cache layout, one snapshot directory per resolved revision, shared by every tree, 124 MB, never in the package). `sense download` prefetches the same model ahead of time; it is idempotent and prints the resolved revision. `embed.model` is a Hugging Face id, or a path to a directory holding `model.safetensors` and `tokenizer.json`, which nothing fetches for you. A preset that asks for vectors when a local model path is missing those files is an error naming the fix, rather than a quieter result that would make the same search answer differently before and after; a preset whose `signals` exclude `vectors` never asks, so it is unaffected. An optional top-level `"embed": { "model", "provider", "url", "key" }` block points at any Model2Vec model, local path, or OpenAI-compatible endpoint (Ollama, LM Studio, hosted). Changing the provider, model, or effective endpoint invalidates stale vectors; changing chunk size rebuilds the affected embedding rows. Explicit builds and watch prepare all configured vectors. A default CLI vector query prepares only its eligible scope; `--no-build` requires that scope to be ready and never prepares it. Unrelated pending documents do not block either path.

Sense adds `has(field, value)` for array membership or string containment and `basename(path)` for path queries on every store. SQLite and DuckDB also provide `segment(terms)` for hand-written matching over text without word spaces. A frontmatter syntax error records `_parse_error` and leaves that file's discovered fields empty; the file's content still enters the index.

## Providers

`embed.provider` picks the wire protocol; `embed.model` names the model. The [verified integrations](https://github.com/kmalakoff/sensemaking/blob/master/INTEGRATIONS.md) record what has actually been run against this codebase. Only those integrations are named as recommendations.

**static**. A local, pure-JS Model2Vec model; no network at query time.

```json
"embed": { "model": "minishlab/potion-retrieval-32M", "provider": "static" }
```

`model` is a Hugging Face id, fetched to `~/.sense/models` on first use, or a path to a local directory holding `model.safetensors` and `tokenizer.json`.

**openai**. Any endpoint serving an OpenAI-shaped `POST /embeddings`.

```json
"embed": { "model": "nomic-embed-text", "provider": "openai", "url": "http://localhost:11434/v1" }
```

Ollama serves this shape at `http://localhost:11434/v1`. LM Studio serves the same shape at `http://localhost:1234/v1`, with narrower platform support than Ollama: Apple Silicon only on Mac, AVX2 on Windows. Content stays on the machine for either. Any other OpenAI-shaped endpoint, including a hosted one, works the same way through `provider: "openai"` and its own `url`; a hosted endpoint means tree content is sent to that service.

**cohere**. Cohere's native `/v2/embed`, which expresses the doc/query distinction (`input_type`) the OpenAI shape cannot.

```json
"embed": { "model": "embed-v4.0", "provider": "cohere", "key": "COHERE_API_KEY" }
```

`key` names the environment variable holding the API key; the key value itself never goes in the config. Content is sent to Cohere.

## Scale

Default CLI queries start with an incremental build of the capabilities they need; only changed files are re-parsed. `--no-build` skips that scan and reads the last completed generation. What to expect as a tree grows:

- **Build work is linear in note count.** Crawl and reconcile are the floor cost of a default query and the first thing to watch on a large tree; `--no-build` avoids them when snapshot semantics are appropriate.
- **Output is flat.** `map`, `peek`, and a search row cost the same on a small tree as a large one: context cost is bounded by what you ask for, not by how much there is.
- **Bulk changes are paid by the next builder.** That is normally the next default query. `sense watch` moves the re-parse into the background ([watch coordination](https://github.com/kmalakoff/sensemaking/blob/master/DESIGN.md#watch-coordination)); `--no-build` continues to read the last completed generation. Run `sense build --force` to recreate the derived index.

## For AI agents

```bash
npx skills add kmalakoff/sensemaking   # -g for global, -a claude-code to target
```

Three skills: `sense` for querying a tree, including store-specific SQL and search guidance; `sense-setup` for creating one and choosing its store, presets, vectors, and note conventions; and `sense-bases` for translating an Obsidian Bases `.base` file into sense SQL.

## Prior art

- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) (Anthropic): agents should hold lightweight identifiers (file paths, links) and load payloads just in time, because context is a finite resource. The commands implement that pattern as a CLI.
- [llm-wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) (Karpathy): an agent-maintained wiki navigated by an `index.md` and links, which he notes needs real search infrastructure past a few hundred pages. `sense map` derives that index from the notes instead of maintaining it; `sense search` is the hybrid local search it calls for.
- Agent memory patterns (llm-wiki's raw/wiki split, Claude Code's dreaming-style nightly consolidation) are trees of small notes with metadata, links, and layers of differing authority. sense is the query layer such patterns need: filter by metadata and age, scope by layer, surface near-duplicates semantically. It isn't an implementation of any one of them.

## Alternatives

- **Obsidian Bases/Dataview:** same filters, but only inside the running app; agents can't query it headless.
- **Index-on-build tools (MarkdownDB):** query a snapshot; `sense` defaults to an incremental build before querying and also offers explicit snapshot reads with `--no-build`.
- **Note CLIs (zk):** fixed schema; `sense` filters on arbitrary frontmatter.
- **Graph/LSP tools (IWE):** structural queries over a markdown graph via LSP/CLI/MCP, retrieval by structure rather than similarity; no SQL, no vector search.
- **Markdown vector stores (markdown-vdb):** hybrid BM25 + vector search over markdown files, no frontmatter filtering; `sense` treats vectors as one signal alongside SQL, not the whole store.
- **RAG / vector stores:** similarity can't express `WHERE status = 'active'`. Here vectors are one signal inside `search`: same database file, filters compose, every row labels its evidence (`via`), and a preset turns vectors off per layer of the tree. No second store, no daemon, no native builds on the default store.
- **Document-OS apps (Anytype, Logseq, SilverBullet, Capacities):** full applications with their own UI and storage. `sense` is headless: your files stay files, there's no app to run.

Dependencies, all pure JS. No native builds by default.

| | |
|---|---|
| [yaml](https://github.com/eemeli/yaml) | frontmatter |
| [markdown-it](https://github.com/markdown-it/markdown-it) | markdown parsing |
| [@huggingface/tokenizers](https://github.com/huggingface/tokenizers.js) | chunking |
| [franc-min](https://github.com/wooorm/franc) | language detection |
| [tinypool](https://github.com/tinylibs/tinypool) | worker pool for parallel parsing on large trees |
| [install-module-linked](https://github.com/kmalakoff/install-module-linked) | installs the optional `duckdb` and `turso` bindings on first use, instead of shipping them to every install |
| Node's built-in SQLite | the default store |

Plus two plugins for the GFM constructs the default preset lacks; tables, strikethrough, and
autolinks are built in:

- [markdown-it-footnote](https://github.com/markdown-it/markdown-it-footnote)
- [markdown-it-task-lists](https://github.com/revin/markdown-it-task-lists)

## License

MIT © Kevin Malakoff
