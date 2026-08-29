// A frontmatter key with punctuation (`plugin-id`, `a.b`) is a real column, but naming it
// unquoted in SQL parses as an expression: `plugin-id` is `plugin - id`, and SQLite's error
// names a fragment (`plugin`) the user never wrote. This maps that fragment back to the
// columns it could have come from, so the error names the actual fix instead.

function startsWithBoundary(name: string, prefix: string): boolean {
  return name.length > prefix.length && name.startsWith(prefix) && /\W/.test(name[prefix.length]);
}

// columns: the tree's frontmatter columns (store.docs.columns()), read by the caller so this
// stays a pure function rather than a store dependency.
export function columnHint(columns: string[], err: Error): Error {
  const match = /no such column: (\S+)/.exec(err.message);
  if (!match) return err;
  const token = match[1];
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
  return new Error(`${err.message} -- ${quoted} needs double quotes in SQL: unquoted, SQLite parses the punctuation as an operator instead of column syntax.`);
}
