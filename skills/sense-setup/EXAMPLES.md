# sense-setup: worked configurations

Four tree shapes, each with its config and the commands an agent actually runs. Field names and folder names are illustrative; your tree defines its own.

## A. Compiled wiki over immutable sources (the llm-wiki pattern)

`raw/` holds ingested sources: big, never hand-edited. `wiki/` holds agent-compiled pages: linked, curated. The human drops sources and asks questions; the agent compiles and cites.

```json
{
  "version": 4,
  "presets": {
    "default": { "include": ["wiki/**/*.md"], "k": 10 },
    "raw":     { "include": ["raw/**/*.md"], "k": 5 }
  },
  "embed": { "model": "minishlab/potion-retrieval-32M", "type": "static" },
  "queries": {
    "uncompiled": { "sql": "SELECT path, _mtime FROM frontmatter WHERE path LIKE 'raw/%' AND path NOT IN (SELECT dst FROM links WHERE dst IS NOT NULL) ORDER BY _mtime DESC" },
    "stubs":      { "sql": "SELECT path, _size FROM frontmatter WHERE path LIKE 'wiki/%' AND _size < 500 ORDER BY _size" },
    "dead-links": { "sql": "SELECT src, target FROM links WHERE dst IS NULL ORDER BY src" }
  }
}
```

```
sense uncompiled                                # compile queue: raw files nothing cites yet
sense search "how does attention scale"         # wiki only (default preset)
sense search "rotary embeddings" --preset raw   # cite from sources, k=5
sense dead-links                                # rows are broken citations to fix
```

What the shape buys: bare search never ranks raw noise above compiled pages; the compile queue, stub list, and citation integrity are one saved query each. The maintenance loop is `uncompiled` → write the wiki page citing its sources → `dead-links` stays empty.

## B. Nightly agent memory, consolidated (the dreaming pattern)

`memory/` accumulates small notes written at session end, each with `project`, `created`, and `kind` (observation / steer / decision) frontmatter. A consolidation agent runs periodically: prune, merge, surface contradictions for the human. Retired notes move to `archive/`: still queryable under their own preset, out of the default scope.

```json
{
  "version": 4,
  "presets": {
    "default": { "include": ["memory/**/*.md"], "k": 10 },
    "archive": { "include": ["archive/**/*.md"], "k": 10 }
  },
  "embed": { "model": "minishlab/potion-retrieval-32M", "type": "static" },
  "queries": {
    "project":    { "sql": "SELECT path, kind, created, title FROM frontmatter WHERE project = ? ORDER BY created DESC" },
    "steers":     { "sql": "SELECT path, created, title FROM frontmatter WHERE kind = 'steer' AND project = ? ORDER BY created" },
    "retirement": { "sql": "SELECT path, project, created FROM frontmatter WHERE datetime(created) < datetime('now','localtime','-90 day') AND path NOT IN (SELECT dst FROM links WHERE dst IS NOT NULL)" },
    "unfiled":    { "sql": "SELECT path FROM frontmatter WHERE project IS NULL" }
  }
}
```

```
sense project acme-app                          # one project's notes, newest first
sense search "prefers terse commit messages" --k 5
  → memory/acme-app/2026-08-02-commits.md   via: match
  → memory/acme-app/2026-06-11-style.md     via: vector  similarity: 0.71   # near-duplicate → merge candidate
sense steers acme-app                           # oldest first: does a new steer override an old one?
sense retirement                                # old + uncited → move to archive/
sense unfiled                                   # rows are notes missing a project — file them
```

Presets are structural (live vs archived); per-project filtering is metadata (`project = ?`). One tree serves every project. Semantic search over the memory preset is the near-duplicate detector: search a new note's own summary and read `similarity` within the results. Whether an old steer was overridden is a question for the human, found by search, never decided by it.

## C. Evidence corpus: claims trace to sources

`sources/` (immutable imports), `notes/` (one reading note per source), `reviews/` (synthesis whose claims must cite notes). The same shape fits incident reports and postmortems, user research and findings, due diligence and memos.

```json
{
  "version": 4,
  "presets": {
    "default": { "include": ["reviews/**/*.md", "notes/**/*.md"], "k": 10 },
    "source":  { "include": ["sources/**/*.md"], "k": 5 }
  },
  "embed": { "model": "minishlab/potion-retrieval-32M", "type": "static" },
  "queries": {
    "unsupported": { "sql": "SELECT path, title FROM frontmatter WHERE path LIKE 'reviews/%' AND path NOT IN (SELECT src FROM links WHERE dst LIKE 'notes/%')" },
    "unread":      { "sql": "SELECT path FROM frontmatter WHERE path LIKE 'sources/%' AND path NOT IN (SELECT dst FROM links WHERE dst IS NOT NULL)" },
    "by-topic":    { "sql": "SELECT path, title FROM frontmatter WHERE path NOT LIKE 'sources/%' AND has(topics, ?) ORDER BY path" }
  }
}
```

```
sense search "replication failures in priming studies"     # reviews + notes; sources never dilute
sense search "the claim's exact phrasing" --preset source  # citation pull on demand
sense unsupported                               # rows are synthesis claims with no note behind them
sense unread                                    # the reading queue: sources no note cites
```

## D. A plain vault: zero configuration

Someone else's Obsidian vault, heterogeneous with no structure worth declaring. The `sense init` starter is left untouched. The workflow is discovery:

```
sense map                                       # fields in use, hub notes, recent changes
sense search "dataview queries"                 # words + links + meaning, one ranked list
sense sql "SELECT j.value AS tag, COUNT(*) n FROM frontmatter, json_each(frontmatter.tags) j GROUP BY j.value ORDER BY n DESC LIMIT 20"
sense peek "Plugins/dataview.md"                # outline + links before reading
```

Presets earn their place only when a tree has parts deserving different treatment; a tree that is one kind of thing needs none of the vocabulary above. On a big vault, raise `default`'s `k` and read `lines` ranges instead of whole files, or start from the starter's `large` preset.
