---
name: sense-setup
description: "Set up the sense CLI on a markdown tree and make the decisions that shape its index: run sense init, choose sqlite, duckdb, or turso, define presets and search signals, configure embeddings, and design queryable note conventions. Use when creating or restructuring a markdown knowledge base, editing sense.config.json, choosing a store or embedding model, or deciding how agents should write notes for later retrieval."
---

# sense setup and tree design

Use this skill to create or change a sense configuration. Querying an existing tree belongs to the `sense` skill. Worked configurations for common tree shapes are in [EXAMPLES.md](EXAMPLES.md).

## Set up the tree

Install the CLI and initialize it at the markdown root:

```sh
npm install -g sensemaking
cd path/to/notes
sense init
sense status
```

`sense init` writes `sense.config.json`. Config discovery walks upward from the current directory. `--config <path>` selects another file.

By default, the config indexes its own directory. A top-level `root` can point at another markdown tree. Relative roots resolve from the config directory, and `.sense/` remains beside the config. Use this when separate consumers need their own presets, saved queries, or caches over one tree.

Globs and indexed paths are relative to the selected root. Run `sense status` and `sense map` after changing the config to confirm preset coverage and the selected store. A change that affects indexed content rebuilds the relevant cache and reports the reason.

## Choose the store

Choose from the intended use of the cache. Start with `sqlite` when no surrounding workflow favors
another engine, then consider interoperability, SQL, connection behavior, and representative Sense
measurements. A current timing result does not define an engine's long-term suitability.

| Store | Choose it when | Main trade-off |
|---|---|---|
| `sqlite` | The tree needs the smallest setup, advanced FTS5 search syntax, or concurrent Sense commands | Included with Node; raw SQL is SQLite |
| `duckdb` | The cache belongs in DuckDB analytical work over large datasets or in a local/cloud workflow, or needs DuckDB types and SQL | Experimental Sense adapter, large native install, one open connection at a time |
| `turso` | The tree benefits from the embedded Rust engine or Tantivy index, or is evaluating the engine as its adapter evolves | Experimental Sense adapter, restricted search grammar, one open connection at a time |

Read the matching selection guide before recommending or configuring a non-default store:

- [SQLite selection guide](references/stores/sqlite.md)
- [DuckDB selection guide](references/stores/duckdb.md)
- [Turso selection guide](references/stores/turso.md)

Read the [current store benchmark summary](references/store-benchmarks.md) only when performance could change the choice. The release assessment generates that shipped summary from the latest accepted all-store run.

Each store uses a separate cache file. Changing `store` rebuilds the index instead of migrating the old cache. Commands and public tables are shared, while raw SQL and advanced word-search syntax follow the selected engine.

## Design presets

A preset is a named, self-contained scope. The required `default` preset serves bare commands. Other presets are selected by name.

| Field | Meaning | Default |
|---|---|---|
| `include` and `exclude` | Files covered by the preset | `include` is required |
| `k` | Search result count | 10 |
| `signals` | Enabled search signals and their reciprocal-rank weights | Every available signal at weight 1 |
| `where` | Standing frontmatter filter | None |

A file is indexed when any preset includes it. Presets can overlap. Files outside every preset do not enter the index.

Use paths for stable layers such as `raw/`, `notes/`, and `archive/`. Use frontmatter filters for changing state such as `status`, `project`, and dates. A preset controls indexing, so its coverage must be computable from paths before frontmatter queries run.

Use separate presets when parts of the tree need different search signals or result counts. A single-purpose tree does not need extra preset vocabulary.

## Configure vectors

Vectors require two choices. The top-level `embed` block names the model and provider. Each preset's `signals` decides whether that scope uses vectors.

```json
{
  "embed": {
    "model": "minishlab/potion-retrieval-32M",
    "provider": "static"
  },
  "presets": {
    "default": {
      "include": ["notes/**/*.md"],
      "signals": { "words": 1, "links": 1, "vectors": 1 }
    },
    "raw": {
      "include": ["raw/**/*.md"],
      "signals": { "words": 1, "links": 1 }
    }
  }
}
```

The first vector search downloads a named static model and embeds the covered notes. `sense download` fetches the model earlier when CI, offline work, or timing makes that useful. A config change that alters the model, vector coverage, or chunking can rebuild vectors.

Read [embedding setup](references/embeddings.md) when choosing a provider or model, supporting a non-English tree, changing chunk size, or tuning signal weights.

## Design queryable notes

Sense accepts heterogeneous markdown. These choices decide which queries will be reliable:

- Consistent frontmatter fields make exact filters and saved reports possible. Inspect actual coverage and types with `sense map`.
- ISO 8601 dates can be compared by the selected store's date functions. Mixed date formats can still be stored, but do not make a dependable time range.
- A one-line `summary` appears in results and receives more lexical weight than body text. Its cost is keeping it current.
- Folders are the natural unit for preset coverage. Frontmatter is the natural unit for status and ownership.
- Small notes give precise hits and cheap whole-file reads. Large notes still work because `peek`, `sections`, and search `lines` point at ranges, and vector chunking splits long sections.
- Save recurring questions under `queries`. Use `{ "sql": "..." }` for deterministic filters and reports, and `{ "search": "..." }` for ranked retrieval.

Field names in examples are illustrative. The tree defines its own schema. Reserved frontmatter keys are `path`, `_mtime`, `_ctime`, `_size`, `_rank`, `_parse_error`, `content`, `links`, and `sections`; sense drops them with a warning.

## Validate the result

Run `sense status` to confirm the store, cache, document count, embedding state, watcher state, and preset coverage. Run `sense map` to confirm the discovered fields and their observed types.

Run every saved query after editing it. A parameterized SQL query can use any value because preparing the statement validates its columns and syntax before the parameter changes the result.

Record choices that should outlive the setup conversation in the tree's maintained agent guidance or in an authored note. The sense config should contain executable settings and reusable queries, not prose policy.
