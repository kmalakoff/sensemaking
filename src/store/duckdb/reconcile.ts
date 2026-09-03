import type { DuckDBValue } from '@duckdb/node-api';
import { SenseError } from '../../errors.ts';
import type { ReconcileDelta } from '../../features/types.ts';
import type { ParsedDoc } from '../../scan/index.ts';
import { CORE_FRONTMATTER_COLUMNS } from '../reconcile.ts';
import { quoteIdent } from '../shared.ts';
import type { Connection, ReconcileDialect } from '../types.ts';
import type { DuckdbConnection } from './connection.ts';
import { markContentStale } from './lexical.ts';
import { duckdbApi } from './native.ts';

// This store's dialect (types.ts's ReconcileDialect) for the shared orchestration in
// store/reconcile.ts. `content` is a plain table, not FTS-virtual, so rows are maintained here
// unconditionally; DuckDB's ALTER TABLE needs a declared type, so every dynamic frontmatter
// column is VARIANT (holds mapValue()'s mixed JS types for one key across files).

// No rowid coupling needed (unlike sqlite's content, which links to frontmatter's rowid):
// `path` is content's own primary key, so this is a plain per-doc row.
const INSERT_CONTENT_SQL = `INSERT INTO content ("path", title, summary, text) VALUES (?, ?, ?, ?)`;

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
  if (docs.length > 0) await conn.runBatch(INSERT_CONTENT_SQL, docs.map(contentRow));
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

// Appender path for rows that cannot conflict (reconcile.ts's `added`); no ON CONFLICT support, so
// alignment reads the table's own physical column order fresh -- `columns` omits feature-owned reserved columns (e.g. "_rank") that still exist on the table, and get appendDefault().
async function insertNew(conn: Connection, table: string, columns: string[], rows: unknown[][]): Promise<void> {
  if (rows.length === 0) return;
  const { variantValue } = await duckdbApi();
  const infoStmt = await conn.prepare(`PRAGMA table_info(${quoteIdent(table)})`);
  const physicalColumns = ((await infoStmt.all()) as Array<{ name: string }>).map((c) => c.name);
  const rowIndexOf = new Map(columns.map((name, i) => [name, i]));

  const native = (conn as DuckdbConnection).duckdb;
  const appender = await native.createAppender(table);
  try {
    for (const row of rows) {
      for (const name of physicalColumns) {
        const idx = rowIndexOf.get(name);
        const value = idx === undefined ? undefined : row[idx];
        if (idx === undefined) appender.appendDefault();
        else if (value === null || value === undefined) appender.appendNull();
        else if (CORE_FRONTMATTER_COLUMNS.has(name)) appender.appendValue(value as DuckDBValue);
        else appender.appendVariant(variantValue(value as DuckDBValue));
      }
      appender.endRow();
    }
    appender.flushSync();
  } finally {
    appender.closeSync();
  }
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
  insertNew,
};
