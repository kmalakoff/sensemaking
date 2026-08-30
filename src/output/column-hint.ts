// A frontmatter key with punctuation (`plugin-id`, `a.b`) is a real column, but unquoted in SQL
// it parses as an expression; this maps SQLite's/DuckDB's fragment error back to the real column.

function startsWithBoundary(name: string, prefix: string): boolean {
  return name.length > prefix.length && name.startsWith(prefix) && /\W/.test(name[prefix.length]);
}

// columns: the tree's frontmatter columns (store.docs.columns()), read by the caller so this
// stays a pure function rather than a store dependency.
export function columnHint(columns: string[], err: Error): Error {
  const match = /no such column: (\S+)|Referenced column "([^"]+)" not found in FROM clause|Referenced table "([^"]+)" not found/.exec(err.message);
  if (!match) return err;
  const token = match[1] ?? match[2] ?? match[3];
  // `f.plugin` -> `plugin`; left as-is when there's no leading alias segment, so a column
  // literally named `a.b` still matches via the full-token check below.
  const aliasStripped = token.replace(/^[A-Za-z_]\w*\./, '');
  const forms = new Set([token, aliasStripped]);
  const candidates = new Set<string>();
  for (const name of columns) {
    for (const form of forms) {
      if (name === form || startsWithBoundary(name, form)) candidates.add(name);
    }
  }
  if (candidates.size === 0) return err;
  const quoted = [...candidates].map((name) => `"${name.split('"').join('""')}"`).join(', ');
  return new Error(`${err.message} -- ${quoted} needs double quotes in SQL: unquoted, the engine parses the punctuation as an operator or a qualifier, not part of a column name.`);
}
