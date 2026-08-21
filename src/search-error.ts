import { SenseError } from './errors.ts';

// FTS5 reads these as operators, so `end-to-end` parses as a filter on column `to` and errors
// `no such column: to` -- true about the parse, misleading about the input.
const FTS5_OPERATORS = /[-'"/.:^*()]/;

export function searchError(err: Error, terms: string, scope?: string): Error {
  const message = err.message;
  if (!/no such column|fts5: syntax error|malformed MATCH/.test(message)) return err;
  const suspects = (terms.match(/\S+/g) ?? []).filter((t) => !t.startsWith('"') && FTS5_OPERATORS.test(t));
  // Blame the terms only when the failing token actually came from one -- a typo'd column
  // in --where (or the tree's default scope) raises "no such column" through this same
  // statement, and naming a term for it would state a false fact about the input.
  const col = /no such column: (\S+)/.exec(message)?.[1];
  const fromTerms = col === undefined ? suspects.length > 0 : suspects.some((t) => t.split(/[^\p{L}\p{N}]+/u).includes(col));
  if (fromTerms && suspects.length > 0) {
    return new SenseError('SEARCH_SYNTAX', `${message} -- the punctuation in ${suspects.map((t) => `\`${t}\``).join(', ')} is FTS5 syntax, not literal text; search for it literally by double-quoting: '"${suspects[0]}"'. Searchable columns are title, summary, text.`);
  }
  if (col !== undefined && scope !== undefined) {
    return new SenseError('SEARCH_SYNTAX', `${message} -- the where condition (${scope}) references it; frontmatter columns are listed by sense sql "SELECT name FROM pragma_table_info('frontmatter')".`);
  }
  return new SenseError('SEARCH_SYNTAX', `${message} -- searchable columns are title, summary, text; frontmatter fields are queried with --where or sense sql (list them with pragma_table_info('frontmatter')).`);
}
