# Design

The decisions behind this library and why, for what a reader cannot recover from
the code alone. Not a map of the codebase: this is what was decided, what it
rejected, and what is still unsettled. [PRINCIPLES.md](PRINCIPLES.md) holds the general
guidelines that generate these decisions; this file holds the decisions
themselves. Working plans are dated local records; durable decisions belong here.

A section here states what the design is, what it rejected, and what is still
unsettled. An unevaluated choice is marked as one rather than defended.

## Search snippets

The `snippets` field on a search row is a list of short passages generated
against the query, with matched terms wrapped in `«»`. It answers "why did this
row match".

It is not an excerpt. An excerpt is static and query-independent, the opening
of a document, the same whatever you searched for. The distinction is not
cosmetic: it decides whether the field is cut around the query or from the
start of the text. Gmail, Tavily and Exa call the query-dependent form a
snippet; Vertex AI Search calls its longer query-independent form an
*extractive segment*. "Excerpt" entered this codebase on 2026-08-15 as loose
prose for a fallback path and spread into function and constant names before
anyone noticed it had changed what the field meant.

### Budget

`SNIPPET_CHAR_LIMIT_DEFAULT` is **80 characters**: the default behind
`--snippet-char-limit`, named for its flag with `_DEFAULT` because that is what
it is. The limit is whatever the caller passes; the constant only says what
happens when they pass nothing. A count default, when that is settled, is
`SNIPPET_COUNT_LIMIT_DEFAULT` by the same rule. Per
PRINCIPLES' *budgets belong to the caller*.

Characters, not tokens: a token is model-specific, so a token budget means a
different thing to every caller. Exa reached the same conclusion, deprecating
`numSentences` and `highlightsPerUrl` for a single `maxCharacters`.

80 is a **convention, not a measured value** — the width of a line of text. It
cannot be tuned without human relevance judgements over a corpus, which is a
research programme rather than a benchmark row. Prior art is all pre-LLM and
disagrees anyway: Elasticsearch and Solr default to 100 characters, Gmail to
about 160 and fixed. Naming it as a convention in one constant is more useful
than a derivation that was never performed.

### Caller interface

`--snippet-char-limit`, a flag on `search`, beside `--k` in `SEARCH_FLAGS`
(`src/cli/shared.ts`), so `named` picks it up from the same group. Default
`SNIPPET_CHAR_LIMIT_DEFAULT`.

The name carries three things a shorter one loses. *snippet* prefixes the
domain, so every future snippet flag sorts beside it in `--help`. *char* names
the unit, which is the decision this design turns on: a budget in tokens would
mean a different thing to every caller. *limit* says it is a ceiling, not a
size, and it usually is one, because a cut lands on a word edge below the cap
and a short note yields a short snippet.

`--snippet-count-limit` bounds snippets per note: the same three parts in the
same order. Parallel rather than a plural (`--snippets-limit`) because two flags
differing by one letter, both taking a number, misread silently.

The two limits are different dimensions and neither substitutes for the other.
`--k` is how many notes come back; `--snippet-count-limit` is how many places
inside each note are shown; `--snippet-char-limit` is how big each of those is.
A note that mentions a term in its intro, a table and a footnote has one best
passage and two more a reader may well want.

No config key. `PRINCIPLES.md`'s *one config home* admits a key only where
different trees legitimately need different values, and a snippet budget is a
property of what a caller is doing right now, triaging fifty hits or reading
three, not of the tree. Built-in constant, flag overrides, nothing in
`sense.config.json` and nothing in `schema.json` to migrate.

Raw `sense sql` needs no flag on sqlite, where FTS5's own `snippet()` takes its
parameters directly. That path is untouched. It does not generalise: duckdb and
turso have no `snippet()` function, so the flag is the only portable channel and
that is why it exists rather than being left to SQL.

### Several snippets per note

`--snippet-count-limit` bounds how many passages come back from one note.
`SNIPPET_COUNT_LIMIT_DEFAULT` is **1**. The default limits are one snippet and
80 characters per snippet. Search returns `snippets: string[]`; callers of the
previous `hit` field must update, and corrected passages can differ. The count
says how many places, the char limit says how big each one is, and the product
is what a row costs.

Selection already scores every candidate window and keeps the top one. Returning
N is the same scoring function: keep the scores instead of discarding them, sort,
take the top N that do not overlap. It is not a second algorithm.

**Non-overlapping, in document order.** Two windows sharing text are one passage
printed twice, so an overlapping candidate is dropped rather than merged: merging
would produce a passage longer than the char limit the caller set. Order is the
note's own, not descending score, because several passages from one note are read
as an abridged note and score order would scramble it. The best-scoring passage
is in the set either way; only its position changes.

**The field is `snippets: string[]`, always an array, even for one.** A lexical
match has one passage by default. A link- or vector-only row has `[]`, because
the note did not contain the search terms. `LexicalHit` stays as the row type,
since a hit is the match. A caller that needs one passage takes the first array
element.

### Rendering a list of snippets

The array is the data. Flattening is the writers' job, and one rule covers all
three formats: **join with a newline.**

| format | rendering |
|---|---|
| json | the array |
| csv | joined with `\n` inside a quoted field |
| table | one snippet per line, the row as tall as its tallest cell |

Newline is the only delimiter our content provably cannot contain. Indexed text
is whitespace-collapsed at extraction and a snippet is collapsed again at cut
(`\s` covers `\n`), so no snippet holds one. Every other candidate can appear in
prose, and `…` demonstrably does: the cut edges add it, and it means "text
continues", the opposite of "next passage".

For csv this is standard rather than a convention we invented. RFC 4180 defines
no array form at all, but it does permit newlines inside a quoted field, and the
writer already quotes any field containing `"`, `\r`, `\n` or `,`. A reader
splits on `\n` after ordinary CSV parsing.

The table writer renders one physical line per snippet and blank-pads the other
columns on continuation lines. CSV joins the array with `\n` inside its quoted
field. JSON retains the array.

Search snippets contain no newlines after whitespace collapsing, so the default
one-snippet output remains one physical line per row. `--snippet-char-limit`
limits each rendered passage, including its marks and ellipses.

The one risk is that `renderRows` is the shared writer for `search`, `related`,
`path` and saved queries, so a spec pins that a single-line row renders exactly
as before.



### Cutting

Cuts fall at **word edges, found with `Intl.Segmenter`**.

This is one rule for every script, with no per-script branch. `Intl.Segmenter`
segments unspaced scripts by dictionary, so `全文検索` yields `全文` and `検索`
with no spaces in the input. A regex word boundary is ASCII-only and would
degrade silently to mid-word cuts in Japanese, Chinese and Thai, so it is never
the mechanism. Sentence-edge cutting was considered and rejected as an
unnecessary special case once word edges were shown to work everywhere.

### Marking

Marking follows what the index matched, per PRINCIPLES' *substring findability*:
a whole word whose case- and accent-insensitive English stem matches a query term
in spaced scripts where the native index supports stemming, the query text wherever
it occurs in unspaced ones. SQLite and DuckDB use their native English stem
tokenizers. Turso's native Tantivy index has no stem tokenizer in the supported
release, so it applies the shared Porter normalization to a derived field before
native indexing. All stores therefore stem `run`, `running`, and `runs`, and fold
accents without rewriting the authored field. A quoted phrase requires adjacent
words with punctuation as separators; punctuation-only input has no lexical rows.
The shared Porter component prepares Turso's query and index fields; it is not a
translated adapter query. Marking a fragment inside a longer word is a bug: a
search for `the` must not mark inside `them`.

### What marking in JS costs

Search computes snippets in shared JavaScript above the store adapters. Release
evidence checks exact authored snippets and line ranges on a fixed candidate set,
then measures store-specific hydration separately. Those checks establish output
correctness. They do not calibrate snippet relevance or choose a performance
baseline. The benchmark numbers of record remain historical until an owner runs
a fresh sitting against the corrected tree.

### Selection, unsettled

Which passage the snippet is cut from is a **separate problem from budget, and
the current answer is unevaluated**. `bestWindowStart` scores every candidate
window by distinct query terms, tie-broken on total occurrences, and takes the
best. Nothing establishes that this beats first-match, and no instrument would
notice a change making it worse. The APIs above tuned their selection against
relevance data; we have not.

Returning several snippets is a caller parameter over the same scores, not a
different algorithm: keep the scores that selection already computes, sort, take
the top non-overlapping, then restore document order.

## Watch coordination

`sense watch` is a long-running process that does not exit on its own. It does
not daemonize itself, because daemonizing and supervising a process is the
caller's job: every platform has its own way to do it, and a config copied here
would go stale. Two decisions follow.

**A stopped watcher never causes a wrong answer.** Every query runs its own
freshness check and reconciles for itself, so the watcher only moves parsing
earlier. It changes latency, never answers. This is what makes the feature
optional rather than load-bearing: nothing depends on it running, and a crashed
watcher degrades to the speed the tree had without one.

Filesystem notifications accelerate reconciliation; a periodic pass covers
notifications the operating system misses. `started` means the watcher resources
are installed, not that the native subscription has signalled readiness.

**One watcher per configuration cache, enforced by a heartbeat rather than a
lock file.** Configurations in different directories may watch the same tree
independently. A second `sense watch` for the same configuration refuses to
start while the config-owned heartbeat is fresh, overridable with `--force` and
inspectable through `sense status`, whose coordinator read is read-only. The
heartbeat worker runs independently of reconciliation, and a killed watcher
expires on its own.

Acquisition and forced replacement write one owner token transactionally.
Heartbeat renewal and shutdown release require that token, so an older watcher
cannot renew or clear a newer owner's claim. The coordination database lives
outside the disposable `.sense` search cache, so an index rebuild cannot erase
live ownership. Forced replacement transfers ownership immediately; it does not
interrupt synchronous native reconciliation already in flight, which the
replaced process drains before exiting.
