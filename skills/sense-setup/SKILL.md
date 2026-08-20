---
name: sense-setup
description: Set up the sense CLI on a markdown tree and make the tree-design decisions that shape it: sense init, presets (which files, which settings, vectors on or off), and the trade-offs of frontmatter conventions, summaries, folder layout, and note size. Use when creating or restructuring a markdown knowledge base, running sense init, editing sense.config.json, configuring search scope or vectors, or deciding how notes should be written for an agent to query later.
---

# sense: setup and tree design

Querying an existing tree is the `sense` skill. This one covers making a tree: installing, writing presets, and the design decisions a tree owner faces. Worked configurations for common tree shapes: [EXAMPLES.md](EXAMPLES.md).

## Setup

- `npm install -g sensemaking`, then `sense init` at the tree root writes `sense.config.json`: two presets (`default`, and `large` showing what a big vault tunes), everything on. Config discovery walks up from cwd; `--config <path>` overrides.
- Globs resolve relative to the config file, never the cwd.
- `sense status` and `sense map` show each preset's coverage (files matched, embedded count), so what a config actually indexes is always visible in output. A config edit that changes coverage rebuilds the cache and names the preset that caused it on stderr.

## Presets

A preset is a named, self-contained bundle of settings. `default` (required) is what bare commands use; every other preset is addressed by name (`sense search "..." --preset raw`, or `"preset": "raw"` in a saved search). No inheritance: what a preset states is all it does.

| field | means | default |
|---|---|---|
| `include` / `exclude` | which files this preset covers (globs) | required |
| `k` | how many results a search returns | 10 |
| `semantic` | vectors for this preset's files and searches | on; only ever written as `false` |
| `where` | a standing SQL filter on frontmatter | none |

**Indexing derives from presets.** A file is indexed if any preset includes it; it is embedded if any covering preset has semantic on. Consequences worth designing around:

- A layer of the tree covered only by a `semantic: false` preset (raw sources, archives, generated output) is fully searchable lexically and by SQL but costs no vector work. This is the main scale lever.
- Files no preset includes are not indexed at all.
- Presets may overlap; they are views, not partitions.
- The first semantic search embeds everything covered (progress on stderr; minutes on tens of thousands of notes, seconds on small trees). Vectors use the built-in static model unless a top-level `"embed": { "model", "type": "static"|"api", "url", "key" }` block points at a Model2Vec model, local path, or OpenAI-compatible endpoint. `static` handles paraphrase and reworded concepts; tight domain jargon ("heart attack" for "myocardial infarction") is where an `api` transformer model tends to do better, measured in BENCHMARKING.md, "Retrieval quality".
- Global `features` (`links`, `sections`, `rank`) still toggle tree-wide; most trees never touch them.

**Large vaults**: everything except the vector build is measured linear to 100k notes with no tuning (BENCHMARKING.md). The knobs that matter are `k` (more, smaller results; rows carry `lines` section ranges, so agents read sections, not files) and `semantic: false` on the layers that don't earn vectors.

## Tree design decisions

These belong to the tree's owner. sense works with any of them and reads no instruction files of its own; each choice only changes what queries can do.

- **Frontmatter fields.** Columns are discovered per tree: whatever keys notes declare become queryable. Consistent fields across notes make SQL filters and named queries possible (`WHERE status = 'active'`). SQLite's compiled column limit (2,000; sqlite.org/limits.html) bounds distinct keys per tree. The crawl stops with an error naming the count and the levers. Reserved keys (dropped with a warning): `path`, `_mtime`, `_size`, `_rank`, `content`, `links`, `sections`. Values keep their YAML type: strings TEXT, whole numbers and booleans INTEGER (`true` is 1), fractions REAL, lists and maps JSON text; `map` prints the observed type per field.
- **Presets are path-shaped; frontmatter is state-shaped.** A preset's coverage must be computable from the path alone (it decides indexing, baked into the cache). Volatile state (`status`, `project`, dates) lives in frontmatter and filters at query time (`where`, `has()`, `datetime()`). A state worth different *indexing* (retired memory, superseded sources) is a state worth moving the file: the archive-folder pattern in EXAMPLES.md.
- **What a note omits is also a filter.** A layer that deliberately carries none of the fields the saved views filter on is excluded from all of them without any view naming the layer. Sparse fields cut both ways: less of the tree filters when you want breadth, and exactly this separation when layers differ in authority.
- **Dates.** `datetime()` comparisons work for dates written as ISO 8601, the only format it parses. A tree that mixes date formats can store them, but can't compare them in SQL.
- **Summaries.** A one-line `summary:` is optional and pays twice: it shows in every result row (often answering a question with no file read) and is a weighted search field ranked above body text. The cost is writing and maintaining the line as notes change.
- **Folder shape.** Globs find the files, paths are queryable text, links resolve by basename at any depth, but presets make folders meaningful: a folder is the natural unit that gets its own coverage and settings.
- **Note size.** Many small notes: precise search hits, whole-file reads stay cheap, more links to maintain. Fewer large notes: `sections`, `peek`, and the `lines` column carry the cost down to line-range reads. Both work.
- **Recurring questions.** Save a scenario an agent will repeat: a SQL string for filters and reports, or a saved search (`"hot": { "search": "...", "preset": "raw", "k": 5 }`). Either runs as `sense <name>`, and `sense check` validates both kinds against the real tree, so a broken saved scenario fails at check time, not mid-task.
- **Where decisions live.** Choices that should outlive one conversation can be recorded in the agent's own instruction or skill files, or in a note in the tree itself; a one-off search over an existing corpus needs none of that.
