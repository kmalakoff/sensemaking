# sensemaking

Query and search your markdown notes with context-aware progressive disclosure: SQL over frontmatter, links, and text, plus semantic search and link-graph ranking. No server, no build step.

## Problem

Markdown notes accumulate: research, decisions, meeting notes, agent output. Past a few dozen, finding the ones relevant to what you're doing means grepping or reading whole folders into context. The structure that makes notes navigable (frontmatter, wikilinks, headings) is exactly what a query needs, but nothing exposes it as a query surface.

`sense` indexes all of it into SQLite and reconciles against file timestamps on every query, so results are never stale and nothing has to be running.

## Quick start

```bash
npm install -g sensemaking
cd your-notes && sense init
sense download          # the embedding model, once per machine; nothing fetches it implicitly
```

Needs Node 22.20 or newer: the first release whose built-in SQLite has both FTS5, which `sense search` indexes prose with, and row-returning `INSERT ... RETURNING`, which `sense path` and `peek` walk the link graph with.

```bash
sense map                                        # orient: fields, hub notes, recent changes
sense search "revenue OR earnings" --k 10        # locate: words + links + meaning, one ranked list
sense peek notes/q3-report.md                    # structure: outline + links, before reading
sense sql "SELECT path FROM frontmatter WHERE has(tags, ?)" urgent
```

## Model

Every file becomes rows in these tables, plus whatever an enabled feature adds of its own:

| table | holds | for |
|---|---|---|
| `frontmatter` | one column per key, plus `path`, `_mtime`, `_size`, `_rank`, `_parse_error` | filtering |
| `content` | FTS5 index: `title`, `summary`, `text`, `path`, plus machine-written `title_seg`/`summary_seg`/`text_seg` sidecars for matching in Chinese, Japanese, Thai, Khmer, Lao, and Burmese | search and ranking |
| `links` | `src`, `target` as written, `dst` resolved (`NULL` = dead link, but see the skill: a link to an attachment can never resolve) | graph |
| `sections` | heading, `level`, `start_line`, `end_line`, `tokens` estimate | structure |
| `preset_files` | `path`, `preset` | which presets cover which files; `sql --preset` binds these as a `scope` table to join, since `sql` is otherwise index-wide |

Results are references (path, title, summary, excerpt), never file contents. Reading happens afterward through the filesystem, scoped to the line ranges `peek` returns. This is the [just-in-time context pattern](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents): the agent holds lightweight identifiers and loads payloads only when needed.

Output size is a contract, measured per release ([BENCHMARKING.md](BENCHMARKING.md)): `map` is fixed-size, a `search` row is tens of tokens, and a `peek` stays flat however large the note is. What it saves over reading grows with the file; a small note is cheaper to read whole.

```sql
-- filter and search compose in one query
SELECT f.path, content.title, snippet(content, -1, '«', '»', '…', 10) AS hit
FROM frontmatter f JOIN content ON content.path = f.path
WHERE f.status = 'active' AND content MATCH 'revenue'
ORDER BY bm25(content, 10.0, 5.0, 1.0) LIMIT 10
```

## Commands

| command | does |
|---|---|
| `map` | doc count, frontmatter field coverage, top hubs by link rank, recent changes |
| `search "<text>" [--preset name] [--include glob] [--exclude glob] [--no-exclude] [--where "<sql>"] [--k n]` | words + links + vectors, one fused ranked list; `via` labels each row's evidence |
| `peek <path> [--preset name] [--where "<sql>"]` | frontmatter + heading outline (`[L143-162, ~380t]`) + links both ways (first 20 per list, each with its total) |
| `path <a> <b> [--max-depth n] [--preset name] [--where "<sql>"]` | shortest link chain between two notes, or none within the bound |
| `related <note> [--k n] [--preset name] [--where "<sql>"]` | notes similar in meaning that `<note>` does not yet link to; reads vectors, so semantic-search cost |
| `sql "<statement>" [params...] [--preset name]` | ad-hoc SQL over all the tables; `?` binds positional args. Index-wide by default; `--preset` binds the preset's paths as a `scope` table the statement joins |
| `<name> [params...]` | run a query saved in the config; `--list` names them |
| `init` | write a starter `sense.config.json` |
| `status` | index location, doc count, per-preset coverage, watcher heartbeat |
| `download` | fetch the embedding model named in the config (once per machine; nothing else downloads it) |
| `watch` | keep the index warm in the background (optional; see [WATCH.md](WATCH.md)) |

`search` runs one text through every engine its scope has: FTS5 word match (BM25-ranked, bare words AND-join, operators are yours), a personalized-PageRank walk over the link graph, and vector similarity, fused into one list. `via` labels each row's evidence (`match`, `link`, `vector`, combinations); `similarity` is the cosine against the best-matching chunk; `lines` points at the section that earned the row (a direct read range). A `vector`-only row means the search words don't appear in that note; it showed up because the model judged it semantically related. `--preset` picks a named settings bundle from the config, `--where` filters on frontmatter. `--format json` on any reporting command returns structured output, and `--format csv` writes the row-returning commands one row per line, for redirecting a large result to a file instead of into context; `--version` and `--help` do what they say.

## Config

`sense init` writes `sense.config.json`; discovery walks up from cwd like git (`--config <path>` overrides).

```json
{
  "$schema": "https://unpkg.com/sensemaking/schema.json",
  "version": 4,
  "presets": {
    "default": { "include": ["**/*.md"], "k": 10 },
    "raw":     { "include": ["raw/**/*.md"], "k": 5 }
  },
  "embed": { "model": "minishlab/potion-retrieval-32M", "type": "static" },
  "queries": {
    "dead-links": { "sql": "SELECT src, target FROM links WHERE dst IS NULL" },
    "by-tag":     { "sql": "SELECT path, title FROM frontmatter WHERE has(tags, ?) ORDER BY path" },
    "hot":        { "search": "pricing OR billing", "preset": "raw" }
  }
}
```

| key | holds |
|---|---|
| `presets` | named bundles of `include`/`exclude` globs, `k` (result count), `semantic` (vectors for this scope, on unless `false`), `where` (a standing SQL filter). A file is indexed if any preset includes it, embedded if a model is named and some covering preset has `semantic` on; `status` shows each preset's coverage. |
| `embed` | the model vectors are built with. Naming one gives the tree vectors; omitting the block means none at all, whatever the presets say. `sense download` fetches it. |
| `content` | settings for the `content` table. `tokenize` names the FTS5 tokenizer, defaulting to `porter unicode61`: name `trigram` for substring matching inside a Latin word, or `unicode61 tokenchars '-_'` to keep hyphenated terms whole. Languages written without word spaces (Chinese, Japanese, Thai, Khmer, Lao, Burmese) need no decision here: they are indexed per grapheme and searched as ordered phrases, substring semantics, what grep gives, needing no minimum length; naming a tokenizer turns that off, since the tree has then chosen its own scheme. Changing it rebuilds the text index only; vectors, links, and sections are kept. |
| `queries` | entries runnable as `sense <name>`, each naming the verb it runs: `{ sql }` for SQL (`?` binds positional args) or `{ search }` for a ranked search with its settings baked in, so `sense hot` needs no flags. Running an entry validates it: a typo'd column errors and exits nonzero, and a parameterised entry validates with any argument, since preparing precedes binding. |
| `version` | schema version; older configs auto-migrate on load, noted on stderr. |

Bare commands use the `default` preset; `--preset` names another; flags override single fields. Editing a preset rebuilds the cache and says which preset caused it.

Vectors need a model, and nothing downloads it implicitly: `sense download` fetches it once per machine into `$XDG_CACHE_HOME/sensemaking/models` (or `~/.cache/...`), one directory per model, shared by every tree (124 MB, never in the package). `embed.model` is a Hugging Face id, or a path to a directory holding `model.safetensors` and `tokenizer.json`, which `sense download` leaves to you to populate. A preset that asks for vectors without the model is an error naming `sense download`, rather than a quieter result that would make the same search answer differently before and after; a `semantic: false` preset never asks, so it is unaffected. An optional top-level `"embed": { "model", "type", "url", "key" }` block points at any Model2Vec model, local path, or OpenAI-compatible endpoint (Ollama, LM Studio, hosted). Embedding the notes themselves happens on the first semantic search, with progress.

Two custom SQL functions. `has(field, value)`: array membership on JSON-array fields, substring on strings, false on missing keys. `segment(terms)`: rewrites a run of Chinese, Japanese, Thai, Khmer, Lao, or Burmese text into the ordered grapheme phrase the sidecar columns need, leaving everything else unchanged, so it is safe to add to any hand-written `MATCH`. Frontmatter parsing is lenient: syntax errors are per-file warnings, and the values are still indexed, so one bad note never costs you the crawl.

## Scale

Every query starts with a freshness check against the cache in `.sense/`; only changed files are re-parsed. What to expect as a tree grows:

- **Work is linear in note count.** Crawl, reconcile, and the freshness check are what every invocation pays; that check is the floor cost of a query and the first thing to watch on a large tree.
- **Output is flat.** `map`, `peek`, and a search row cost the same on a small tree as a large one: context cost is bounded by what you ask for, not by how much there is.
- **Bulk changes are paid by whoever queries next.** `sense watch` moves that re-parse into the background ([WATCH.md](WATCH.md)): it changes latency, never answers, since every query reconciles for itself. To start the cache over, delete the directory `sense status` prints.

These are release gates rather than hopes: every release regenerates the numbers on pinned corpora spanning a 4x range in note count plus a stress tree that packs the worst measured shapes into one place: a megabyte-scale note, heading-dense outlines, dense link graphs, hundreds of frontmatter fields. A row that grows faster than linearly, or a token count that grows at all, blocks the release. Current figures: [BENCHMARKING.md](BENCHMARKING.md).

## For AI agents

```bash
npx skills add kmalakoff/sensemaking   # -g for global, -a claude-code to target
```

Two skills: `sense` for querying a tree (what each command is for, FTS5 syntax, reading the `via`/`score`/`similarity` columns, worked examples) and `sense-setup` for making one, where features, frontmatter conventions, and note size are decisions with consequences either way.

## Prior art

- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) (Anthropic): agents should hold lightweight identifiers (file paths, links) and load payloads just in time, because context is a finite resource. The commands implement that pattern as a CLI.
- [llm-wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) (Karpathy): an agent-maintained wiki navigated by an `index.md` and links, which he notes needs real search infrastructure past a few hundred pages. `sense map` derives that index from the notes instead of maintaining it; `sense search` is the hybrid local search it calls for.
- Agent memory patterns (llm-wiki's raw/wiki split, Claude Code's dreaming-style nightly consolidation) are trees of small notes with metadata, links, and layers of differing authority. sense is the query layer such patterns need: filter by metadata and age, scope by layer, surface near-duplicates semantically. It isn't an implementation of any one of them.

## Alternatives

- **Obsidian Bases/Dataview:** same filters, but only inside the running app; agents can't query it headless.
- **Index-on-build tools (MarkdownDB):** query a snapshot; `sense` reconciles on every query.
- **Note CLIs (zk):** fixed schema; `sense` filters on arbitrary frontmatter.
- **Graph/LSP tools (IWE):** structural queries over a markdown graph via LSP/CLI/MCP, retrieval by structure rather than similarity; no SQL, no vector search.
- **Markdown vector stores (markdown-vdb):** hybrid BM25 + vector search over markdown files, no frontmatter filtering; `sense` treats vectors as one signal alongside SQL, not the whole store.
- **RAG / vector stores:** similarity can't express `WHERE status = 'active'`. Here vectors are one signal inside `search`: same SQLite file, filters compose, every row labels its evidence (`via`), and a preset turns vectors off per layer of the tree. No second store, no daemon, no native builds.
- **Document-OS apps (Anytype, Logseq, SilverBullet, Capacities):** full applications with their own UI and storage. `sense` is headless: your files stay files, there's no app to run.

Dependencies: [yaml](https://github.com/eemeli/yaml), [remove-markdown](https://github.com/zuchka/remove-markdown), [@huggingface/tokenizers](https://github.com/huggingface/tokenizers.js) (pure JS), and Node's built-in SQLite. No native builds.

## License

MIT © Kevin Malakoff
