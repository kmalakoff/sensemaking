# Search evidence and troubleshooting

Read this guide when search results will support a factual claim, when absence matters, when results look noisy, or when changing signal weights.

[Sense terminology](terminology.md) defines the result objects. In particular, snippets, sections and embedding chunks are different units.

## What each signal establishes

`words` ranks literal occurrences after stemming. It is the right signal for identifiers, error strings, names, and quoted phrases. A `match` row is lexical evidence because its `snippets` show the occurrence.

`links` expands from matching notes through links written by the authors. A `link` row establishes that relationship, but does not establish that the row contains the query words.

`vectors` ranks the meaning of chunks. It can find paraphrases and related concepts with no shared vocabulary. A `vector` row is a lead to read. It cannot prove that a word or claim appears in the note.

Search uses every signal named by the preset. If `signals` is absent, every signal whose prerequisites hold has weight 1. A number changes that signal's contribution to reciprocal-rank fusion:

```json
"signals": { "words": 1, "links": 1, "vectors": 4 }
```

Weights are corpus and model choices. Compare representative queries before changing them. One weight does not transfer reliably between unrelated trees or embedding models.

## Reading the rows

- `via` names the evidence that produced the row.
- `snippets` contains marked lexical passages. It is empty when no word matched.
- `lines` is the selected section or embedding chunk's line range in the indexed note. Null means the whole note is the reference.
- `score` orders the fused result. Its scale changes with the participating signals and ranks, so compare rows only inside one result.
- `similarity` is cosine similarity against the best chunk. Compare it inside one result and one model. Small trees can give unrelated text a moderately close nearest neighbor.

Relay the evidence label when reporting a result. "The note contains these words" and "the note is semantically related" support different claims.

## Finite retrieval and paging

`k` is the maximum number of notes returned by one finite retrieval. Changing `k` can change the candidate pools, link seeds and fused ranking, including the earlier rows. It starts a new retrieval rather than continuing a stable result set. When you need pages, retain one returned array or JSON result and page that locally.

## Explain a ranking

Add `--explain` to a direct `sense search` invocation when you need to inspect how the configured signals contributed. With `--format json`, each returned row adds an `explanation` array containing `signal`, `rank`, `weight` and `contribution`. Entries follow words, links, vectors order and include only signals that contributed to that candidate. Without the flag, ordinary output is unchanged.

Ranks are one-based within each signal's candidate list. A contribution is `weight / (60 + rank - 1)`, using the actual unrounded value accumulated during ranking. The sum is the fused score before its public display rounding. These values are not native BM25 scores and do not make lexical rankings comparable across stores.

An isolated word-match seed can receive link-signal restart mass while its `via` label remains `match`. The explanation reports the numeric contribution; `via` remains the evidence label, not an exhaustive score breakdown. An explanation does not establish that a claim is true or describe why an absent note failed to enter the candidate set.

Table and CSV formats encode the explanation cell as JSON text. Table output follows the existing cell clipping rules; use JSON or CSV for the complete values. Explanation reuses the current search and does not make an additional embedding request. It is not a saved-query configuration field.

## When a search misses

For word search, try concrete terms that the notes may use, widen the selected preset, or raise `--k`. Search grammar depends on the selected store. Read its guide before adding operators.

For vector search, restate the concept in different words. Then use `related <path>` on the nearest useful hit to inspect its semantic neighborhood.

Each widening step adds candidates and can dilute the ranking. Inspect the new rows before widening again.

## Absence

A words-only preset returns no rows when the terms do not occur in its indexed scope. With vectors enabled, nearest-neighbor search can still return vector-only rows for any input. Those rows show conceptual proximity, not lexical presence.

When absence matters, use a preset whose `signals` excludes `vectors`, or query the selected store's text index as described in its guide. Confirm the preset's coverage with `sense status` before concluding that the terms are absent from the tree.

## Template-heavy trees

Vectors rank whole chunks, including repeated boilerplate. In a tree whose notes share a large template and contain little unique prose, unrelated seeds can return the same neighbors with almost identical similarities. Compare two unlike seed notes. If their neighbor lists barely change, search the fields or words that distinguish the notes instead.
