# sense: worked examples

Outputs below are illustrative. Every result is a reference; reading happens afterward, through
the filesystem, on the paths that earned it.

## A. "Does the vault say anything about X?"

```
sense find "pricing OR billing OR invoicing" --k 10 --format json
```

```json
[
  { "path": "notes/pricing-model.md", "title": "Pricing model",
    "summary": "Tiered per-seat pricing; floor and discount rules", "hit": "«Pricing» floor for annual…", "via": "match+link", "score": 0.0333 },
  { "path": "notes/renewal-playbook.md", "title": "Renewal playbook",
    "summary": "Renewal sequence and owners", "hit": "…«billing» contact confirms the PO…", "via": "match", "score": 0.0313 }
]
```

~30 tokens per row; often the `summary` answers the question with no read at all. A row with
`via: "link"` never contained the terms — it is linked from notes that did, usually a signal
worth following, not noise.

## B. Known-field filtering (no search)

```
sense query "SELECT path, title, status FROM frontmatter WHERE status = 'active' AND has(tags, ?)" pricing --format json
```

Plain SQL on discovered columns. Combine with search by joining `content` and adding
`AND content MATCH ?` — filter and rank in one query.

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

## E. Cold start on an unknown vault

```
sense map                          # fields, hubs, recent — read this first
sense --list                       # named queries someone already saved
sense query "SELECT DISTINCT type FROM frontmatter"    # what a field's values are
```

## Anti-patterns

| don't | because | instead |
|---|---|---|
| `SELECT text FROM content` | dumps the vault into context | `snippet(content, -1, '«', '»', '…', 10)` |
| `sense find "pricing"` | one word misses synonyms | `"pricing OR billing OR invoicing"` |
| `Read` a 4,000-token file for one section | 10× the tokens needed | `peek` first, `Read` the line range |
| queries without `LIMIT` | unbounded output | `LIMIT 10`, widen only if all rows look wrong |
| save every query to config | config churn for one-offs | ad-hoc `sense query`; save only reusable views |
