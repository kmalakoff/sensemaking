# SQLite query guide

Read this guide when `store` is `sqlite` or omitted.

SQLite is the default store. It uses Node's built-in SQLite, keeps the cache at `.sense/cache.db`, supports concurrent sense commands through WAL, and implements the full search grammar documented here.

## `sense search` grammar

Search text uses FTS5 syntax:

- Bare words are joined with AND. If one word is absent, the lexical signal returns no row.
- `a OR b` matches either word.
- `pref*` matches a token prefix.
- `"exact phrase"` requires adjacent tokens.
- `NEAR(a b, 5)` limits token distance.
- `^term` requires the token at the start of a column.
- `title:term` and `summary:term` filter by indexed column.
- Parentheses group expressions.

Double-quote terms containing punctuation. Bare `customer-facing` treats the hyphen as syntax, and a bare apostrophe is invalid.

## Raw text search

`content` is an FTS5 virtual table. Refer to it by its table name in `MATCH`, even when the `FROM` clause has an alias:

```sql
SELECT content.path, content.title
FROM content
WHERE content MATCH ?
ORDER BY bm25(content, 10.0, 5.0, 1.0)
LIMIT 20;
```

The three BM25 weights rank title above summary above body. For queries that can match the machine-written unspaced-script sidecars, use all eight weights so the sidecars receive the same field weighting:

```sql
ORDER BY bm25(content, 10.0, 5.0, 1.0, 0, 10.0, 5.0, 1.0)
```

Raw `snippet(content, 2, '«', '»', '…', 10)` targets the authored body column. Avoid `-1` because it may choose a machine-written sidecar. SQLite's `snippet()` tokenizes the matched text again, so prefer `sense search` for large notes. Sense builds its own bounded passages on every store.

## Functions and unspaced scripts

`has()`, `basename()`, and `segment()` are registered SQL functions. `sense search` handles Chinese, Japanese, Thai, Khmer, Lao, and Burmese automatically. Hand-written `MATCH` cannot be rewritten, so pass such terms through `segment()`:

```sql
SELECT path FROM content WHERE content MATCH segment(?);
```

`segment()` leaves other text unchanged.

## Dates and values

Use SQLite's `datetime()` to compare ISO 8601 values with different offsets:

```sql
WHERE datetime(created) >= datetime(?)
```

SQLite's `now` is UTC. A calendar-day query in the machine's local timezone needs `localtime`:

```sql
WHERE date(created) = date('now', 'localtime')
```

Frontmatter values use SQLite storage classes. Booleans are integers, so compare true with 1. Lists and maps are JSON text and can be expanded with `json_each()`.
