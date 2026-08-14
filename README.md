# sensemaking

SQL over a tree of markdown notes: filter by frontmatter, search the prose, follow the links,
read the structure. A CLI that starts, answers, and exits — no server, no build step.

## Problem

Working with AI agents produces piles of small notes. Past a few dozen, finding the right ones
means grepping or reading whole folders into context. The structure that makes notes navigable —
frontmatter, wikilinks, headings — is exactly what an agent needs, but nothing exposes it as a
query surface.

`sense` indexes all of it into SQLite and reconciles against file timestamps on every query, so
results are never stale and nothing has to be running.

## Quick start

```bash
npm install -g sensemaking
cd your-notes && sense init
```

```bash
sense map                                        # orient: fields, hub notes, recent changes
sense find "revenue OR earnings" --k 10          # locate: ranked references with excerpts
sense peek notes/q3-report.md                    # structure: outline + links, before reading
sense query "SELECT path FROM frontmatter WHERE has(tags, ?)" urgent
```

## Model

Every file becomes rows in four tables:

| table | holds | for |
|---|---|---|
| `frontmatter` | one column per key, plus `path`, `_mtime`, `_size`, `_rank` | filtering |
| `content` | FTS5 index: `title`, `summary`, `text` | search and ranking |
| `links` | `src`, `target` as written, `dst` resolved (`NULL` = dead link) | graph |
| `sections` | heading, `level`, `start_line`, `end_line`, `tokens` estimate | structure |

Results are references — path, title, summary, excerpt — never file contents. Reading happens
afterward through the filesystem, scoped to the line ranges `peek` returns. This is the
[just-in-time context pattern](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents):
the agent holds lightweight identifiers and loads payloads only when needed.

Measured costs: a `find` row is ~20–40 tokens, a `peek` is ~17% of reading the file, and the
section it points at is a direct `Read` range.

```sql
-- filter and search compose in one query
SELECT f.path, content.title, snippet(content, -1, '«', '»', '…', 10) AS hit
FROM frontmatter f JOIN content ON content.path = f.path
WHERE f.status = 'active' AND content MATCH 'revenue'
ORDER BY bm25(content, 10.0, 5.0, 1.0) LIMIT 10
```

## Verbs

| verb | does |
|---|---|
| `map` | doc count, frontmatter field coverage, top hubs by link rank, recent changes |
| `find "<terms>" [--where "<sql>"] [--k n] [--semantic]` | BM25 + link-graph expansion, fused; `via` marks each row `match`, `link`, or `match+link` |
| `peek <path>` | frontmatter + heading outline (`[L143-162, ~380t]`) + links both ways, capped at 20 per list |
| `query "<sql>" [params...]` | ad-hoc SQL over all four tables; `?` binds positional args |

`find` seeds a personalized-PageRank walk with the BM25 matches, so a note that never contains
the terms but is linked from ones that do still surfaces. Terms pass verbatim to FTS5 `MATCH`
(bare words AND-join; operators are yours to write). `--where` takes a frontmatter condition
against alias `f`. On trees with the `embed` feature, `--semantic` additionally expands by
meaning — explicit per query, never silent; rows it adds are labeled `via: vector` and carry a
`lines` column pointing at the best-matching section.
`--format json` on any verb returns structured output.

## Config

`sense init` writes `sense.config.json`; discovery walks up from cwd like git
(`--config <path>` overrides). Name reusable queries and run them as `sense <name> [params...]`:

```json
{
  "$schema": "https://unpkg.com/sensemaking/schema.json",
  "version": 2,
  "scan": { "include": ["**/*.md"] },
  "features": { "links": true, "sections": true, "rank": true },
  "queries": {
    "by-tag": "SELECT path, title FROM frontmatter WHERE has(tags, ?) ORDER BY path"
  }
}
```

Features toggle independently; disabling one degrades its verb instead of failing it (`find`
goes BM25-only without `links`, `map` drops hubs without `rank`, `peek` drops the outline
without `sections`). Toggling rebuilds the cache. Older config versions auto-migrate on load,
noted on stderr.

`embed` is the one opt-in feature (absent = off; most trees don't need vectors): `"embed": true`
uses the built-in static model (downloaded to `~/.cache/sensemaking` on first use, never in the
package), or `{ "model", "type": "static"|"api", "url", "key" }` points at any Model2Vec model,
local path, or OpenAI-compatible endpoint (Ollama, LM Studio, hosted). With it on, vectors stay
fresh at reconcile and `find --semantic` uses them; default `find` results are unchanged.

## Reference

- `has(field, value)` — the one custom SQL function: array membership on JSON-array fields,
  substring on strings (so `has(f.status, 'active')` also matches `inactive`), false on missing
  keys. Exact matches: `=` for scalars, `EXISTS (SELECT 1 FROM json_each(f.tags) WHERE value = ?)`
  for array members.
- Reserved frontmatter keys (dropped with a warning): `path`, `_mtime`, `_size`, `_rank`,
  `content`, `links`, `sections`.
- FTS5 syntax in `MATCH`: `a OR b`, `"phrase"`, `pref*`, `NEAR(a b, 5)`, `summary: term`.
  Stemmed; markdown is stripped at index time. `bm25(content, 10.0, 5.0, 1.0)` weights title
  over summary over body.
- A one-line `summary:` in frontmatter is both a selectable column and a weighted search field.
- Exit codes: `0` ok, `1` error (SQLite message verbatim), `2` usage.
- Frontmatter parsing is lenient: syntax errors (an alias starting with `@`, say) are per-file
  warnings and the values are still indexed.

## Scale

Every query starts with a freshness check against the cache in `.sense/`; only changed files are
re-parsed. Measured per release in [BENCHMARKING.md](BENCHMARKING.md) — at 6,566 notes: full
crawl ~5 s, warm query ~100 ms, one-file change ~200 ms. `sense watch` (optional) moves
re-parsing into the background — see [WATCH.md](WATCH.md). `sense rebuild` deletes the cache and
re-crawls.

## For AI agents

```bash
npx skills add kmalakoff/sensemaking   # -g for global, -a claude-code to target
```

The skill teaches the descent: `map` to orient, `find` to locate, `peek` before reading,
`Read` line ranges instead of files.

## Prior art

- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
  (Anthropic): agents should hold lightweight identifiers — file paths, links — and load payloads
  just in time, because context is a finite resource. The four verbs implement that pattern as a CLI.
- [llm-wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) (Karpathy): an
  agent-maintained wiki navigated by an `index.md` and links, which he notes needs real search
  infrastructure past a few hundred pages. `sense map` derives that index from the notes instead of
  maintaining it; `find` is the hybrid local search it calls for.

## Alternatives

- **Obsidian Bases/Dataview** — same filters, but only inside the running app; agents can't
  query it headless.
- **Index-on-build tools (MarkdownDB)** — query a snapshot; `sense` reconciles on every query.
- **Note CLIs (zk)** — fixed schema; `sense` filters on arbitrary frontmatter.
- **RAG / vector stores** — similarity can't express `WHERE status = 'active'`. Here vectors are
  the optional `embed` feature: same SQLite file, filters compose, expansion is explicit per
  query (`find --semantic`) and labeled — no second store, no daemon, no native builds.

Dependencies: [yaml](https://github.com/eemeli/yaml),
[remove-markdown](https://github.com/zuchka/remove-markdown),
[fast-glob](https://github.com/mrmlnc/fast-glob), and Node's built-in SQLite. No native builds.

## License

MIT © Kevin Malakoff
