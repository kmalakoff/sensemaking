# sense: worked examples

Outputs below are illustrative. Every result is a reference; reading happens afterward, through
the filesystem, on the paths that earned it.

## A. "Do the notes say anything about X?"

```
sense search "pricing OR billing OR invoicing" --k 10 --format json
```

```json
[
  { "path": "notes/pricing-model.md", "title": "Pricing model",
    "summary": "Tiered per-seat pricing; floor and discount rules", "hit": "«Pricing» floor for annual…", "via": "match+link", "score": 0.0333, "lines": null },
  { "path": "notes/renewal-playbook.md", "title": "Renewal playbook",
    "summary": "Renewal sequence and owners", "hit": "…«billing» contact confirms the PO…", "via": "match", "score": 0.0313, "lines": "L81-140" }
]
```

Tens of tokens per row; often the `summary` answers the question with no read at all. A row with
`via: "link"` never contained the terms — it is linked from notes that did. `lines`, when
set, is the section that earned the row, a direct `Read` range.

## B. Known-field filtering (no search)

```
sense query "SELECT path, title, status FROM frontmatter WHERE status = 'active' AND has(tags, ?)" pricing --format json
```

Plain SQL on discovered columns. Combine with search by joining `content` and adding
`AND content MATCH ?` — filter and rank in one query.

Per-member counts on an array field (GROUP BY on the raw column would split `["a","b"]` from
`["b","a"]`):

```
sense query "SELECT j.value AS tag, COUNT(*) n FROM frontmatter, json_each(frontmatter.tags) j GROUP BY j.value ORDER BY n DESC"
```

## C. Structure before reading

```
sense peek notes/architecture-decisions.md
```

```
notes/architecture-decisions.md  (~4400 tokens)
  title: Architecture decisions
sections:
  ## Storage layer — why SQLite  [L41-88, ~610t]
  ## Queue — rejected options  [L89-120, ~380t]
  ...
links out (7): notes/pricing-model.md, ...
backlinks (2): notes/_index.md, notes/roadmap.md
```

The note is ~4,400 tokens; the peek is ~500. If only one section matters, `Read` its line range
(~400 tokens) — a tenth of the file.

## D. The graph

```
sense query "SELECT src FROM links WHERE dst = ?" notes/pricing-model.md    # who cites this
sense query "SELECT src, target FROM links WHERE dst IS NULL"               # dead links
sense query "SELECT path, round(_rank*100,2) r FROM frontmatter ORDER BY _rank DESC LIMIT 5"  # load-bearing notes
```

`sense map` prints the hub list without SQL; use these when you need it filtered or joined.

## E. Cold start on an unknown notes tree

```
sense map                          # fields, hubs, recent — read this first
sense --list                       # named queries someone already saved
sense query "SELECT DISTINCT type FROM frontmatter"    # what a field's values are
```

## F. "The notes say it in different words"

```
sense search "children dying from poor nutrition" --k 3 --format json
```

```json
[
  { "path": "notes/malnutrition-outcomes.md", "title": "Malnutrition outcomes",
    "summary": "Stunting and mortality by region", "hit": null, "via": "vector", "score": 0.0167, "similarity": 0.61, "lines": "L14-52" }
]
```

A `via: "vector"` row never contained the terms — it is semantically near them; `similarity` is
the cosine against the chunk `lines` names, a direct `Read` range. Vector rows appear whenever
the scope's preset has semantic on (the default); a result of only vector rows means the words
themselves are nowhere in the scope.

## Consequences

| query | what happens | bounded alternative |
|---|---|---|
| `SELECT text FROM content` | returns the tree's entire prose | `snippet(content, -1, '«', '»', '…', 10)` excerpts the match |
| `snippet()` on a tree holding a megabyte-scale note | re-tokenizes the whole document per matched row: seconds per query | bound it: `CASE WHEN length(content.text) <= 16384 THEN snippet(...) END`, or select `summary` instead |
| `sense search "pricing"` | lexically matches only that word's stem (vector rows still widen by meaning) | OR-in synonyms and instances: `"pricing OR billing OR invoicing"` |
| `sense search "pricing model details"` | bare words AND-join; one absent word = zero lexical rows | OR the words, or quote an exact phrase |
| `sense search "customer-facing OR on-site"` | bare punctuation is FTS5 syntax (`-` reads as a column filter) | double-quote: `"customer-facing" OR "on-site"` |
| `Read` of a large file for one section | costs the whole file | `peek`, then `Read` the line range |
| row queries without `LIMIT` | unbounded output (aggregates are already bounded) | `LIMIT n` |
| saving one-off queries to config | config churn | ad-hoc `sense query`; save reusable views |
