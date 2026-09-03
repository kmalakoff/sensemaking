import { SenseError } from '../../errors.ts';
import type { ReconcileDelta } from '../../features/types.ts';
import type { ParsedDoc } from '../../scan/index.ts';
import { appendRows, quoteIdent } from '../shared.ts';
import type { Connection, ReconcileDialect } from '../types.ts';
import { markContentStale } from './lexical.ts';

// This store's dialect (types.ts's ReconcileDialect) for the shared orchestration in
// store/reconcile.ts. `content` is a plain table, not FTS-virtual, so rows are maintained here
// unconditionally; DuckDB's ALTER TABLE needs a declared type, so every dynamic frontmatter
// column is VARIANT (holds mapValue()'s mixed JS types for one key across files).

// No rowid coupling needed (unlike sqlite's content, which links to frontmatter's rowid):
// `path` is content's own primary key, so this is a plain per-doc row.
const CONTENT_COLUMNS = ['path', 'title', 'summary', 'text'];
const INSERT_CONTENT_SQL = `INSERT INTO content (${CONTENT_COLUMNS.map(quoteIdent).join(', ')}) VALUES (?, ?, ?, ?)`;

function contentRow(doc: ParsedDoc): unknown[] {
  return [doc.relPath, doc.search.title, doc.search.summary, doc.search.text];
}

// No compile-time column cap in DuckDB (unlike SQLite's SQLITE_MAX_COLUMN); kept as a sanity fence anyway
// so a runaway frontmatter generator fails with a clear message instead of an unbounded ALTER TABLE loop.
const MAX_FRONTMATTER_COLUMNS = 10_000;

async function reconcileContent(conn: Connection, touched: string[], docs: ParsedDoc[], _delta: ReconcileDelta): Promise<void> {
  if (touched.length > 0)
    await conn.runBatch(
      'DELETE FROM content WHERE "path" = ?',
      touched.map((p) => [p])
    );
  // The delete above cleared every touched path, and duckdb holds the cache file for its whole
  // connection, so no second writer can have landed one of these rows: nothing can conflict.
  await appendRows(conn, 'content', CONTENT_COLUMNS, INSERT_CONTENT_SQL, docs.map(contentRow));
  // content changed: the fts index is rebuilt lazily, on the next lexical query that needs it,
  // not here (lexical.ts's FtsIndexState).
  markContentStale(conn);
}

// DuckDB rejects more than one ALTER command per statement ("Parser Error: Only one ALTER
// command per statement is supported", measured), so every name's clause joins into one string
// and runs as a single exec() -- one column-add "leg" through the driver instead of `names.length`.
// VARIANT is the only type that can hold the mixed bigint/number/string/null shapes mapValue()
// produces for one key across files.
async function addColumns(conn: Connection, names: string[]): Promise<void> {
  if (names.length === 0) return;
  await conn.exec(names.map((name) => `ALTER TABLE frontmatter ADD COLUMN ${quoteIdent(name)} VARIANT`).join('; '));
}

export const duckdbDialect: ReconcileDialect = {
  beginMode: () => 'BEGIN',
  checkColumnLimit(count) {
    if (count > MAX_FRONTMATTER_COLUMNS) {
      throw new SenseError('COLUMN_LIMIT', `frontmatter would need ${count} columns, crossing this store's sanity limit (${MAX_FRONTMATTER_COLUMNS}). Narrow the presets' include globs so fewer/other files are indexed, or fix whatever is generating unbounded frontmatter keys.`);
    }
  },
  addColumns,
  reconcileContent,
};
