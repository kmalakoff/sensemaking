# sense-bases: worked translations

Two real `.base` shapes translated end to end. Field names are illustrative; your tree
defines its own.

## A. Filtered, sorted table with formulas

The base: notes categorized as Movies, excluding templates, with a "To-watch" view of unseen
entries sorted by score.

```yaml
filters:
  and:
    - categories.contains(link("Movies"))
    - '!file.name.contains("Template")'
views:
  - type: table
    name: To-watch
    filters:
      and:
        - last.isEmpty()
        - rating.isEmpty()
    order: [file.name, year, scoreImdb, runtime, director]
    sort:
      - { property: scoreImdb, direction: DESC }
      - { property: file.name, direction: ASC }
```

One view, one query. Base filters AND view filters; `order` is the SELECT list; `sort` the
ORDER BY. The link comparison is the literal written text (`[[Movies]]`), the name test uses
`basename` so a folder named Templates does not false-positive:

```sql
SELECT basename(f.path, '.md') AS name, f.year, f.scoreImdb, f.runtime, f.director
FROM frontmatter f
WHERE EXISTS (SELECT 1 FROM json_each(f.categories) WHERE value = '[[Movies]]')
  AND instr(basename(f.path), 'Template') = 0
  AND (f.last IS NULL OR f.last = '[null]')
  AND (f.rating IS NULL OR f.rating = '[null]')
ORDER BY f.scoreImdb DESC, name ASC
```

Saved in `sense.config.json` under `queries` as e.g. `to-watch`, it runs as `sense to-watch`.

## B. `this`-relative: the Related pattern

The base: for the current note, every other note ranked by shared outgoing links, including
anything it links or that links to it.

```yaml
filters:
  and:
    - file.path != this.file.path
formulas:
  Related: list(this.file.links).filter(list(file.links).containsAny(value)).unique()
  LinksOverlap: formula.Related.length
views:
  - type: table
    name: Related
    filters:
      or:
        - formula.LinksOverlap > 2
        - file.hasLink(this)
        - this.file.hasLink(file)
    sort:
      - { property: formula.LinksOverlap, direction: DESC }
    limit: 20
```

`this` becomes one bound path. The chained list formula (`filter(...containsAny).unique()`)
is set intersection, which SQL states as an IN-filtered count; the `Related` list itself is
the same rows through `GROUP_CONCAT`:

```sql
WITH me AS (SELECT ? AS p),
mine AS (SELECT DISTINCT dst FROM links, me WHERE src = me.p AND dst IS NOT NULL),
scored AS (
  SELECT f.path,
    (SELECT COUNT(DISTINCT l.dst) FROM links l
      WHERE l.src = f.path AND l.dst IN (SELECT dst FROM mine)) AS overlap,
    EXISTS (SELECT 1 FROM links, me WHERE src = f.path AND dst = me.p) AS links_to_me,
    EXISTS (SELECT 1 FROM links, me WHERE src = me.p AND dst = f.path) AS linked_by_me,
    (SELECT GROUP_CONCAT(DISTINCT l.dst) FROM links l
      WHERE l.src = f.path AND l.dst IN (SELECT dst FROM mine)) AS shared_links
  FROM frontmatter f, me WHERE f.path != me.p)
SELECT path, overlap, shared_links FROM scored
WHERE overlap > 2 OR links_to_me OR linked_by_me
ORDER BY overlap DESC
LIMIT 20
```

Run as `sense sql "..." current-note.md`, or saved with the `?` in place and the path passed
as the parameter. The `or:` block reproduces Obsidian's semantics exactly: rows qualify by
overlap, by linking to the note, or by being linked from it -- so leaf notes the current note
links to appear even at zero overlap, as they do in Obsidian.

## Notes that recur across translations

- Multiple views over the same base share the base-level filter; write it once per query
  rather than factoring it out -- saved queries are self-contained by design.
- `sort` keys referencing formulas sort by the SELECT alias.
- A `groupBy` view keeps its rows; see the window-function shape in SKILL.md. Only a
  deliberately collapsed report wants `GROUP BY`.
