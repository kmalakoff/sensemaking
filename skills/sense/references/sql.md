# Portable SQL

Read this guide for raw SQL over sense tables. These patterns use the shared schema and avoid native text-index syntax. Read the selected store's query guide as well when the statement uses dates, JSON table functions, native types, or text matching.

## Discover the tree before assuming fields

Frontmatter columns come from the indexed notes. Inspect them before writing a field query:

```sh
sense map
sense sql "SELECT name FROM pragma_table_info('frontmatter')"
sense sql "SELECT DISTINCT status FROM frontmatter ORDER BY status"
```

Punctuated field names need double quotes. Values should use `?` parameters:

```sh
sense sql 'SELECT path FROM frontmatter WHERE "plugin-id" = ? LIMIT 50' example
```

`content.title` and `content.summary` always exist. A frontmatter column with either name exists only when at least one indexed note declares it.

## Shared tables

| Table | Main columns |
|---|---|
| `frontmatter` | `path`, discovered fields, `_mtime`, `_ctime`, `_size`, `_rank`, `_parse_error` |
| `content` | `path`, `title`, `summary`, `text` |
| `links` | `src`, `target`, `dst`, `embed` |
| `tags` | `path`, `tag` |
| `sections` | `path`, `heading`, `level`, `start_line`, `end_line`, `tokens` |
| `preset_files` | `path`, `preset` |

`links.dst` is null when the written target does not resolve to indexed markdown. `links.embed` is 1 for an embed and 0 for an ordinary wikilink. The `tags` table merges frontmatter and inline tags and stores a nested tag such as `book/scifi` in full.

## Shared query patterns

```sql
SELECT COUNT(*) AS notes FROM frontmatter;

SELECT path, title
FROM frontmatter
WHERE status = ?
ORDER BY path
LIMIT 50;

SELECT src
FROM links
WHERE dst = ?
ORDER BY src;

SELECT heading, start_line, end_line, tokens
FROM sections
WHERE path = ?
ORDER BY start_line;

SELECT path, tag
FROM tags
WHERE tag = ? OR tag LIKE ?
ORDER BY path;
```

For a nested tag family, bind the same value twice as `book` and `book/%`.

`has(field, value)` works on every store. It tests membership for a JSON array and substring presence for a scalar string. Use `field = ?` for exact scalar equality because `has(status, 'active')` also matches `inactive`.

`basename(path[, suffix])` works on every store. `segment(terms)` is available on SQLite and DuckDB only; the store guides explain when it is needed.

## Preset scope

`sense sql` covers the whole index unless it receives `--preset`. With that flag, sense binds a temporary `scope(path)` table and requires the statement to join it:

```sh
sense sql "SELECT f.path FROM frontmatter f JOIN scope ON scope.path = f.path ORDER BY f.path" --preset default
```

A saved SQL query written against `scope` can run under different presets without duplicating the statement. Without `--preset`, join `preset_files` directly and name the preset in SQL.

## Graph queries

Bound recursive walks. An unrestricted walk on a dense graph can enumerate paths faster than it eliminates them.

```sql
WITH RECURSIVE hop(path, d) AS (
  SELECT ?, 0
  UNION
  SELECT CASE WHEN l.src = hop.path THEN l.dst ELSE l.src END, hop.d + 1
  FROM hop
  JOIN links l ON (l.src = hop.path OR l.dst = hop.path) AND l.dst IS NOT NULL
  WHERE hop.d < 2
)
SELECT DISTINCT path FROM hop WHERE d > 0;
```

Use `sense path` for the shortest chain between two known notes. Use raw recursion when the task needs a set of neighbors to filter or join.

## Dead links

`dst IS NULL` includes links to attachments that sense never indexes, such as images, PDFs, and `.base` files. Exclude the attachment extensions used by the tree before treating the remaining rows as broken links. Trees with dotted markdown titles need an explicit extension list instead of a blanket "contains a dot" filter.

Templates and examples can also contain deliberately unresolved wikilinks. Scope the query to authored content when those files are indexed.

## Types and parse errors

YAML strings remain text, whole numbers and booleans remain integer-like values, fractions remain real-like values, and lists and maps remain structured or JSON-backed values according to the store. Use `sense map` to see the types observed for each field. Read the store guide before comparing a field that contains more than one type.

A malformed frontmatter block produces `_parse_error` and no recovered field values. This query lists the files to fix:

```sql
SELECT path, _parse_error
FROM frontmatter
WHERE _parse_error IS NOT NULL
ORDER BY path;
```

To find notes that genuinely omit `status`, use `status IS NULL AND _parse_error IS NULL`.

## Bound the output

Select only the columns required by the task and add `LIMIT` while exploring. Avoid `SELECT text FROM content` because it returns the tree's prose. Use `search` for bounded passages, or select `path`, `title`, and `summary` and read the relevant files afterward.
