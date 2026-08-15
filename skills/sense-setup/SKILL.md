---
name: sense-setup
description: Set up the sense CLI on a markdown tree and make the tree-design decisions that shape it — sense init, enabling features (links, sections, rank, embed), and the trade-offs of frontmatter conventions, summaries, folder layout, and note size. Use when creating or restructuring a markdown knowledge base, running sense init, editing sense.config.json, enabling semantic search, or deciding how notes should be written for an agent to query later.
---

# sense: setup and tree design

Querying an existing tree is the `sense` skill. This one covers making a tree:
installing, configuring features, and the design decisions a tree owner faces.

## Setup

- `npm install -g sensemaking`, then `sense init` at the tree root writes
  `sense.config.json` (all opt-out features on, `embed` off). Config discovery
  walks up from cwd; `--config <path>` overrides.
- `scan.include` globs resolve relative to the config file, never the cwd.
- `sense map` and `sense status` report feature state
  (`features: links, sections, rank · off: embed (features.embed)`), so the
  current config is always discoverable from output.

## Features

| feature | powers | cost when on | config key |
|---|---|---|---|
| `links` | backlinks, dead-link queries, `find`'s link expansion, `peek`'s link lists | link re-resolution at reconcile | `features.links` (default on) |
| `sections` | `peek`'s outline, line-range reads, per-section token estimates | heading extraction at parse | `features.sections` (default on) |
| `rank` | `map`'s hubs, `_rank` in any ORDER BY | PageRank pass at reconcile; requires `links` | `features.rank` (default on) |
| `embed` | `find --semantic` (meaning-based expansion) | the first semantic query embeds the whole tree (minutes on tens of thousands of notes, progress on stderr); after that, a model load per invocation (measured in BENCHMARKING.md as `semantic_find_ms` minus `find_ms`) | `features.embed` (default off) |

- `embed` accepts `true` (built-in static model) or an object: `model` (Hugging
  Face id or local path), `type` (`static` pure-JS built-in, or `api` for any
  OpenAI-compatible `/v1/embeddings` endpoint — Ollama, LM Studio, llama.cpp,
  hosted), `url`, `key` (env var name). A local `model` path is fully offline.
- The two types differ in what they match, not only in cost: `static` is a
  context-free distilled model that handles paraphrase and reworded concepts
  (a query like "delegating without micromanaging" can reach a note that uses
  neither word); tight near-synonyms and domain jargon ("heart attack" for
  "myocardial infarction") are where it misses and an `api` transformer model
  tends to succeed. The gain concentrates where the searcher's vocabulary
  differs from the notes' — measured in the retrieval eval (BENCHMARKING.md,
  "Retrieval quality"): on a vocabulary-gap corpus semantic expansion adds
  recall; where vocabulary overlaps, BM25 plus link expansion already answers
  most queries and vectors mostly reorder.
- Enabling `embed` changes no default `find` result — expansion runs only when
  a query passes `--semantic`. Invoking `--semantic` on a tree without `embed`
  is an error naming the config key.
- Toggling any feature rebuilds the cache on the next query (safe, automatic).
- Disabled features degrade output, visibly: `peek` prints
  `sections: off (features.sections)` rather than an empty outline.
- Every query reconciles for itself, so nothing has to be running. On a
  large tree that changes in bulk — a sync, a generated batch — whoever
  queries next pays that re-parse; `sense watch` moves it into the
  background instead. It changes latency, never answers, and the OS
  supervises it rather than the CLI (WATCH.md ships launchd and systemd
  units).

## Tree design decisions

These belong to the tree's owner. sense works with any of them and reads no
instruction files of its own; each choice below only changes what queries can
do, and every consequence is listed so the choice can be made deliberately.

- **Frontmatter fields.** Columns are discovered per tree — whatever keys notes
  declare become queryable. Consistent fields across notes make SQL filters
  and named queries possible (`WHERE status = 'active'`). SQLite's compiled
  column limit (2,000; sqlite.org/limits.html) bounds distinct keys per tree —
  the crawl stops with an error naming the count and the levers, which in
  practice only a generator writing unbounded keys ever hits. Reserved keys
  (dropped with a warning): `path`, `_mtime`, `_size`, `_rank`, `content`,
  `links`, `sections`. Values keep their YAML type: strings TEXT, whole numbers
  and booleans INTEGER (`true` is 1), fractions REAL, lists and maps JSON text;
  `map` prints the observed type per field.
- **What a note omits is also a filter.** A layer that deliberately carries none
  of the fields the saved views filter on is excluded from all of them without
  any view naming the layer; only a view filtering solely on a field the layer
  does share needs an explicit condition (`AND type != 'raw'`). Sparse fields cut
  both ways: less of the tree filters when you want breadth, and exactly this
  separation when layers differ in authority — source extractions vs.
  conclusions, generated output vs. notes.
- **Dates.** `datetime()` comparisons work for dates written as ISO 8601 —
  the only format it parses. A tree that mixes date formats can store them,
  but can't compare them in SQL.
- **Summaries.** A one-line `summary:` is optional and pays twice: it shows in
  every result row (often answering a question with no file read) and is a
  weighted search field ranked above body text. The cost is writing and
  maintaining the line as notes change.
- **Folder shape.** sense is structure-indifferent: globs find the files,
  paths are queryable text, links resolve by basename at any depth. Folders
  are for the humans and agents navigating the tree, not for the index —
  flat and nested trees query identically.
- **Note size.** Many small notes: precise `find` hits, whole-file reads stay
  cheap, more links to maintain. Fewer large notes: `sections` and `peek`
  carry the cost down to line-range reads. Both work; per-section token
  estimates exist either way.
- **Recurring questions.** A scenario an agent will run repeatedly can be saved
  with its settings: a SQL string for filters and reports, or a saved find
  (`"hot": { "find": "...", "k": 20, "semantic": true }`) for searches — either
  runs as `sense <name>`, and `sense check` validates both kinds against the
  real tree, so a broken saved scenario fails at check time, not mid-task.
- **Where decisions live.** Choices that should outlive one conversation can
  be recorded in the agent's own instruction or skill files, or in a note in
  the tree itself; a one-off search over an existing corpus needs none of
  that. Whether to settle a choice with the user or proceed on the corpus as
  found depends on whether the agent is only querying or also authoring —
  an authoring agent's choices compound; a querying agent's don't.
