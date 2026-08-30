// A frontmatter key with punctuation (`plugin-id`, `a.b`) is a real column, but unquoted in SQL
// it parses as an expression: `plugin - id`, or table `a` column `b`. SQLite names a fragment
// (`no such column: plugin`), DuckDB names the fragment or the table (`Referenced column/table
// "..." not found`); this maps either back to the real column so the error names the fix.

function startsWithBoundary(name: string, prefix: string): boolean {
  return name.length > prefix.length && name.startsWith(prefix) && /\W/.test(name[prefix.length]);
}

// columns: the tree's frontmatter columns (store.docs.columns()), read by the caller so this
// stays a pure function rather than a store dependency.
export function columnHint(columns: string[], err: Error): Error {
  const match = /no such column: (\S+)|Referenced column "([^"]+)" not found in FROM clause|Referenced table "([^"]+)" not found/.exec(err.message);
  if (!match) return err;
  const token = match[1] ?? match[2] ?? match[3];
  // `f.plugin` -> `plugin`; left as-is when there's no leading alias segment, which also
  // covers a column literally named `a.b` -- the full-token check below matches that case
  // directly, so stripping here never needs to special-case it.
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
