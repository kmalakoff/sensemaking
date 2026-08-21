# sensemaking

Query and search your markdown notes with context-aware progressive disclosure: SQL over frontmatter, links, and text, plus semantic search and link-graph ranking. No server, no build step.

## Problem

Markdown notes accumulate: research, decisions, meeting notes, agent output. Past a few dozen, finding the ones relevant to what you're doing means grepping or reading whole folders into context. The structure that makes notes navigable (frontmatter, wikilinks, headings) is exactly what a query needs, but nothing exposes it as a query surface.

`sense` indexes all of it into SQLite and reconciles against file timestamps on every query, so results are never stale and nothing has to be running.

## Quick start

```bash
npm install -g sensemaking
cd your-notes && sense init
```

Needs Node 22.16 or newer: that is the first release whose built-in SQLite carries FTS5, which `sense search` indexes prose with.

```bash
sense map                                        # orient: fields, hub notes, recent changes
sense search "revenue OR earnings" --k 10        # locate: words + links + meaning, one ranked list
sense peek notes/q3-report.md                    # structure: outline + links, before reading
sense query "SELECT path FROM frontmatter WHERE has(tags, ?)" urgent
```

## Model

Every file becomes rows in these tables, plus whatever an enabled feature adds of its own:

| table | holds | for |
|---|---|---|
| `frontmatter` | one column per key, plus `path`, `_mtime`, `_size`, `_rank` | filtering |
| `content` | FTS5 index: `title`, `summary`, `text` | search and ranking |
| `links` | `src`, `target` as written, `dst` resolved (`NULL` = dead link) | graph |
| `sections` | heading, `level`, `start_line`, `end_line`, `tokens` estimate | structure |

Results are references (path, title, summary, excerpt), never file contents. Reading happens afterward through the filesystem, scoped to the line ranges `peek` returns. This is the [just-in-time context pattern](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents): the agent holds lightweight identifiers and loads payloads only when needed.

Output size is a contract, measured per release ([BENCHMARKING.md](BENCHMARKING.md)): `map` is fixed-size, a `find` row is tens of tokens, and a `peek` stays flat however large the note is. What it saves over reading grows with the file; a small note is cheaper to read whole.

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
| `search "<text>" [--preset name] [--include glob] [--exclude glob] [--where "<sql>"] [--k n] [--lexical]` | words + links + vectors, one fused ranked list; `via` labels each row's evidence |
| `peek <path> [--preset name] [--where "<sql>"]` | frontmatter + heading outline (`[L143-162, ~380t]`) + links both ways (first 20 per list, each with its total), plus `nearby` (notes a few hops out) |
| `path <a> <b> [--max-depth n] [--preset name] [--where "<sql>"]` | shortest link chain between two notes, or none within the bound |
| `related <note> [--k n] [--preset name] [--where "<sql>"]` | notes similar in meaning that `<note>` does not yet link to; reads vectors, so semantic-search cost |
| `query "<sql>" [params...]` | ad-hoc SQL over all the tables; `?` binds positional args |
| `<name> [params...]` | run a query saved in the config; `--list` names them |
| `init` | write a starter `sense.config.json` |
| `status` | index location, doc count, per-preset coverage, watcher heartbeat |
| `check` | run every saved query and search, so a broken one fails here instead of mid-task |
| `rebuild` | delete the cache and re-crawl |
| `watch` | keep the index warm in the background (optional; see [WATCH.md](WATCH.md)) |

`search` runs one text through every engine its scope has: FTS5 word match (BM25-ranked, bare words AND-join, operators are yours), a personalized-PageRank walk over the link graph, and vector similarity, fused into one list. `via` labels each row's evidence (`match`, `link`, `vector`, combinations); `similarity` is the cosine against the best-matching chunk; `lines` points at the section that earned the row (a direct read range). A `vector`-only row means the search words don't appear in that note; it showed up because the model judged it semantically related. `--preset` picks a named settings bundle from the config, `--lexical` skips vectors for one command, `--where` filters on frontmatter. `--format json` on any reporting command returns structured output; `--version` and `--help` do what they say.

## Config

`sense init` writes `sense.config.json`; discovery walks up from cwd like git (`--config <path>` overrides).

```json
{
  "$schema": "https://unpkg.com/sensemaking/schema.json",
  "version": 3,
  "presets": {
    "default": { "include": ["**/*.md"], "k": 10 },
    "raw":     { "include": ["raw/**/*.md"], "k": 5, "semantic": false }
  },
  "queries": {
    "dead-links": "SELECT src, target FROM links WHERE dst IS NULL",
    "by-tag": "SELECT path, title FROM frontmatter WHERE has(tags, ?) ORDER BY path",
    "hot": { "search": "pricing OR billing", "preset": "raw" }
  }
}
```

| key | holds |
|---|---|
| `presets` | named bundles of `include`/`exclude` globs, `k` (result count), `semantic` (vectors, on unless `false`), `where` (a standing SQL filter). A file is indexed if any preset includes it, embedded if any covering preset has `semantic` on. A `semantic: false` preset's files cost no vectors, and `status` shows each preset's coverage. |
| `queries` | a SQL string (`?` binds positional args) or a saved search with its settings baked in: `sense hot` needs no flags. `sense check` runs them all, so a typo'd column fails at check time instead of mid-task. |
| `version` | schema version; older configs auto-migrate on load, noted on stderr. |

Bare commands use the `default` preset; `--preset` names another; flags override single fields. Editing a preset rebuilds the cache and says which preset caused it.

Vectors use the built-in static model (downloaded to `~/.cache/sensemaking` on first use, never in the package); an optional top-level `"embed": { "model", "type", "url", "key" }` block points at any Model2Vec model, local path, or OpenAI-compatible endpoint (Ollama, LM Studio, hosted). Embedding happens on the first semantic search, with progress.

`has(field, value)` is the one custom SQL function: array membership on JSON-array fields, substring on strings, false on missing keys. Frontmatter parsing is lenient: syntax errors are per-file warnings, and the values are still indexed, so one bad note never costs you the crawl.

## Scale

Every query starts with a freshness check against the cache in `.sense/`; only changed files are re-parsed. What to expect as a tree grows:

- **Work is linear in note count.** Crawl, reconcile, and the freshness check are what every invocation pays; that check is the floor cost of a query and the first thing to watch on a large tree.
- **Output is flat.** `map`, `peek`, and a search row cost the same on a small tree as a large one: context cost is bounded by what you ask for, not by how much there is.
- **Bulk changes are paid by whoever queries next.** `sense watch` moves that re-parse into the background ([WATCH.md](WATCH.md)): it changes latency, never answers, since every query reconciles for itself. `sense rebuild` starts the cache over.

These are release gates rather than hopes: every release regenerates the numbers on pinned corpora spanning a 4x range in note count plus a stress tree that packs the worst measured shapes into one place: a megabyte-scale note, heading-dense outlines, dense link graphs, hundreds of frontmatter fields. A row that grows faster than linearly, or a token count that grows at all, blocks the release. Current figures: [BENCHMARKING.md](BENCHMARKING.md).

## For AI agents

```bash
npx skills add kmalakoff/sensemaking   # -g for global, -a claude-code to target
```

Two skills: `sense` for querying a tree (what each command is for, FTS5 syntax, reading the `via`/`score`/`similarity` columns, worked examples) and `sense-setup` for making one, where features, frontmatter conventions, and note size are decisions with consequences either way.

## Prior art

- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) (Anthropic): agents should hold lightweight identifiers (file paths, links) and load payloads just in time, because context is a finite resource. The commands implement that pattern as a CLI.
- [llm-wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) (Karpathy): an agent-maintained wiki navigated by an `index.md` and links, which he notes needs real search infrastructure past a few hundred pages. `sense map` derives that index from the notes instead of maintaining it; `find` is the hybrid local search it calls for.
- Agent memory patterns (llm-wiki's raw/wiki split, Claude Code's dreaming-style nightly consolidation) are trees of small notes with metadata, links, and layers of differing authority. sense is the query layer such patterns need: filter by metadata and age, scope by layer, surface near-duplicates semantically. It isn't an implementation of any one of them.

## Alternatives

- **Obsidian Bases/Dataview:** same filters, but only inside the running app; agents can't query it headless.
- **Index-on-build tools (MarkdownDB):** query a snapshot; `sense` reconciles on every query.
- **Note CLIs (zk):** fixed schema; `sense` filters on arbitrary frontmatter.
- **Graph/LSP tools (IWE):** structural queries over a markdown graph via LSP/CLI/MCP, retrieval by structure rather than similarity; no SQL, no vector search.
- **Markdown vector stores (markdown-vdb):** hybrid BM25 + vector search over markdown files, no frontmatter filtering; `sense` treats vectors as one signal alongside SQL, not the whole store.
- **RAG / vector stores:** similarity can't express `WHERE status = 'active'`. Here vectors are one signal inside `search`: same SQLite file, filters compose, every row labels its evidence (`via`), and a preset turns vectors off per layer of the tree. No second store, no daemon, no native builds.
- **Document-OS apps (Anytype, Logseq, SilverBullet, Capacities):** full applications with their own UI and storage. `sense` is headless: your files stay files, there's no app to run.

Dependencies: [yaml](https://github.com/eemeli/yaml), [remove-markdown](https://github.com/zuchka/remove-markdown), [fast-glob](https://github.com/mrmlnc/fast-glob), [@huggingface/tokenizers](https://github.com/huggingface/tokenizers.js) (pure JS), and Node's built-in SQLite. No native builds.

## License

MIT © Kevin Malakoff
