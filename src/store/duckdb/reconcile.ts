import type { DuckDBConnection, DuckDBPreparedStatement, DuckDBValue } from '@duckdb/node-api';
import { SenseError } from '../../errors.ts';
import type { ReconcileDelta } from '../../features/types.ts';
import type { ParsedDoc } from '../../scan/index.ts';
import { appendRows, quoteIdent } from '../shared.ts';
import type { Connection, ReconcileDialect } from '../types.ts';
import type { DuckdbConnection } from './connection.ts';
import { markContentStale } from './lexical.ts';
import { duckdbApi } from './native.ts';

// This store's dialect (types.ts's ReconcileDialect) for the shared orchestration in
// store/reconcile.ts. `content` is a plain table, not FTS-virtual, so changed rows are maintained
// here; DuckDB's ALTER TABLE needs a declared type, so every dynamic frontmatter
// column is VARIANT (holds mapValue()'s mixed JS types for one key across files).

// No rowid coupling needed (unlike sqlite's content, which links to frontmatter's rowid):
// `path` is content's own primary key, so this is a plain per-doc row.
const CONTENT_COLUMNS = ['path', 'title', 'summary', 'text'];
const INSERT_CONTENT_SQL = `INSERT INTO content (${CONTENT_COLUMNS.map(quoteIdent).join(', ')}) VALUES (?, ?, ?, ?)`;
// Bound the extra persisted text held for exact comparison, even during a full reparse.
const CONTENT_LOOKUP_CHUNK = 128;

interface ContentRow {
  path: string;
  title: string | null;
  summary: string | null;
  text: string | null;
}

function contentRow(doc: ParsedDoc): unknown[] {
  return [doc.relPath, doc.search.title, doc.search.summary, doc.search.text];
}

// No compile-time column cap in DuckDB (unlike SQLite's SQLITE_MAX_COLUMN); kept as a sanity fence anyway
// so a runaway frontmatter generator fails with a clear message instead of an unbounded ALTER TABLE loop.
const MAX_FRONTMATTER_COLUMNS = 10_000;
const FRONTMATTER_UPDATE_CHUNK = 128;

async function withNativeStatement<T>(native: DuckDBConnection, sql: string, fn: (stmt: DuckDBPreparedStatement) => Promise<T>): Promise<T> {
  const stmt = await native.prepare(sql);
  const errors: unknown[] = [];
  let result!: T;
  try {
    result = await fn(stmt);
  } catch (err) {
    errors.push(err);
  }
  try {
    stmt.destroySync();
  } catch (err) {
    errors.push(err);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'frontmatter statement and cleanup failed');
  return result;
}

// Wide writes amplify native commit allocations even for one changed stamp.
// Skip only known, exactly equal values; uncertain representations still write.
async function updateFrontmatter(conn: Connection, writableColumns: string[], rows: unknown[][]): Promise<void> {
  if (rows.length === 0) return;
  const native = (conn as DuckdbConnection).duckdb;
  const { DuckDBVariantValue, DuckDBTypeId } = await duckdbApi();
  const physical = await withNativeStatement(native, 'PRAGMA table_info(frontmatter)', async (stmt) => {
    const reader = await stmt.runAndReadAll();
    return reader.getRowObjectsJS() as Array<{ name: string; type: string }>;
  });
  const writable = new Map(writableColumns.map((name, i) => [name, i]));
  const pathIndex = writable.get('path');
  if (pathIndex === undefined) throw new Error('frontmatter update requires a writable path column');
  const columnTypes = new Map(physical.map((column) => [column.name, column.type]));
  const insertSql = `INSERT INTO frontmatter (${writableColumns.map(quoteIdent).join(', ')}) VALUES (${writableColumns.map(() => '?').join(', ')})`;
  const sameValue = (old: DuckDBValue, value: unknown, column: string): boolean => {
    if (value === null || value === undefined) return old === null;
    if (columnTypes.get(column) !== 'VARIANT') return Object.is(old, value);
    if (!(old instanceof DuckDBVariantValue)) return false;
    const typeId = typeof value === 'string' ? DuckDBTypeId.VARCHAR : typeof value === 'bigint' ? DuckDBTypeId.HUGEINT : typeof value === 'number' && !Number.isInteger(value) ? DuckDBTypeId.DOUBLE : undefined;
    return typeId !== undefined && old.type?.typeId === typeId && Object.is(old.value, value);
  };
  for (let i = 0; i < rows.length; i += FRONTMATTER_UPDATE_CHUNK) {
    const chunk = rows.slice(i, i + FRONTMATTER_UPDATE_CHUNK);
    const paths = chunk.map((row) => row[pathIndex] as string);
    const placeholders = paths.map(() => '?').join(', ');
    const selected = writableColumns.map(quoteIdent).join(', ');
    const existing = await withNativeStatement(native, `SELECT ${selected} FROM frontmatter WHERE "path" IN (${placeholders})`, async (stmt) => {
      stmt.bind(paths);
      const reader = await stmt.runAndReadAll();
      // Native wrappers distinguish numeric tags and SQL NULL from VARIANT null.
      return new Map(reader.getRowObjects().map((row) => [row.path as string, row]));
    });
    const plans = chunk.map((row) => {
      const old = existing.get(row[pathIndex] as string);
      const changed = old ? writableColumns.flatMap((column, index) => (sameValue(old[column], row[index], column) ? [] : [index])) : [];
      return { row, missing: old === undefined, changed, signature: changed.join(',') };
    });
    for (let position = 0; position < plans.length; ) {
      const plan = plans[position];
      if (!plan.missing && plan.changed.length === 0) {
        ++position;
        continue;
      }
      let end = position + 1;
      while (end < plans.length && plans[end].missing === plan.missing && plans[end].signature === plan.signature) ++end;
      if (plan.missing) {
        await appendRows(
          conn,
          'frontmatter',
          writableColumns,
          insertSql,
          plans.slice(position, end).map((repair) => repair.row)
        );
      } else {
        const assignments = plan.changed.map((index) => `${quoteIdent(writableColumns[index])} = ?`).join(', ');
        await withNativeStatement(native, `UPDATE frontmatter SET ${assignments} WHERE "path" = ?`, async (stmt) => {
          for (let rowIndex = position; rowIndex < end; ++rowIndex) {
            const row = plans[rowIndex].row;
            stmt.bind([...plan.changed.map((index) => row[index] ?? null), row[pathIndex]] as DuckDBValue[]);
            await stmt.run();
          }
        });
      }
      position = end;
    }
  }
}

async function reconcileContent(conn: Connection, touched: string[], docs: ParsedDoc[], delta: ReconcileDelta): Promise<void> {
  const added = new Set(delta.added);
  const reparsed = docs.filter((doc) => !added.has(doc.relPath));
  const changed = new Set(delta.added);
  const removed: string[] = [];
  for (let i = 0; i < reparsed.length; i += CONTENT_LOOKUP_CHUNK) {
    const chunk = reparsed.slice(i, i + CONTENT_LOOKUP_CHUNK);
    const stmt = await conn.prepare(`SELECT "path", title, summary, text FROM content WHERE "path" IN (${chunk.map(() => '?').join(', ')})`);
    const rows = (await stmt.all(...chunk.map((doc) => doc.relPath))) as ContentRow[];
    const existing = new Map(rows.map((row) => [row.path, row]));
    for (const doc of chunk) {
      const row = existing.get(doc.relPath);
      if (row && row.title === doc.search.title && row.summary === doc.search.summary && row.text === doc.search.text) continue;
      changed.add(doc.relPath);
      if (row) removed.push(doc.relPath);
    }
  }

  const docPaths = new Set(docs.map((doc) => doc.relPath));
  const vanished = touched.filter((path) => !docPaths.has(path));
  for (let i = 0; i < vanished.length; i += CONTENT_LOOKUP_CHUNK) {
    const chunk = vanished.slice(i, i + CONTENT_LOOKUP_CHUNK);
    const stmt = await conn.prepare(`SELECT "path" FROM content WHERE "path" IN (${chunk.map(() => '?').join(', ')})`);
    const rows = (await stmt.all(...chunk)) as Array<{ path: string }>;
    removed.push(...rows.map((row) => row.path));
  }

  if (removed.length > 0)
    await conn.runBatch(
      'DELETE FROM content WHERE "path" = ?',
      removed.map((p) => [p])
    );
  // Keep document order and the existing insert/error semantics for added paths.
  const changedDocs = docs.filter((doc) => changed.has(doc.relPath));
  await appendRows(conn, 'content', CONTENT_COLUMNS, INSERT_CONTENT_SQL, changedDocs.map(contentRow));
  // Commit the stale mark with actual content changes. Identical rows leave prior staleness
  // untouched, and FTS preparation still owns missing-index recovery.
  if (removed.length > 0 || changedDocs.length > 0) await markContentStale(conn);
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
  updateFrontmatter,
  reconcileContent,
};
