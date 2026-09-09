import { SenseError } from '../errors.ts';
import { hasUnspacedRun } from '../text/segment.ts';

// FTS5 reads punctuation as syntax, so `end-to-end` parses as a filter on column `to` and
// errors `no such column: to` -- true about the parse, misleading about the input.
const FTS5_PUNCTUATION = /[^\p{L}\p{M}\p{N}_\s]/u;

// SQLite treats punctuation in an unquoted spaced-script token as MATCH syntax. Validate that
// boundary before dispatch so DuckDB and Tantivy do not silently interpret the same input as text.
export function bareTermSyntaxError(terms: string): Error | null {
  const outsideQuotes = terms.replace(/"[^"]*"/g, ' ');
  const suspects = (outsideQuotes.match(/\S+/g) ?? []).filter((token) => {
    if (!FTS5_PUNCTUATION.test(token) || hasUnspacedRun(token)) return false;
    if (/^[\p{L}_]\w*\s*:/u.test(token)) return false;
    if (/^[\p{L}\p{N}_]+\*(?:\s|$)/u.test(token)) return false;
    if (/^(?:AND|OR|NOT)$/u.test(token)) return false;
    return true;
  });
  if (suspects.length === 0) return null;
  return new SenseError('SEARCH_SYNTAX', `the punctuation in ${suspects.map((term) => `\`${term}\``).join(', ')} is FTS5 syntax, not literal text; search for it literally by double-quoting: '"${suspects[0]}"'. Searchable columns are title, summary, text.`);
}

export function searchError(err: Error, terms: string, scope?: string): Error {
  const message = err.message;
  if (!/no such column|fts5: syntax error|malformed MATCH/.test(message)) return err;
  const suspects = (terms.match(/\S+/g) ?? []).filter((t) => !t.startsWith('"') && FTS5_PUNCTUATION.test(t));
  // Blame the terms only when the failing token actually came from one -- a typo'd column
  // in --where can raise "no such column" through this same statement.
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
