import type { Config } from '../../config/index.ts';
import { SenseError } from '../../errors.ts';
import type { ReconcileDelta } from '../../features/types.ts';
import type { ParsedDoc } from '../../scan/index.ts';
import { segmentField } from '../../text/segment.ts';
import { quoteIdent, recordReconcileDuration } from '../shared.ts';
import { BEGIN_WRITE } from '../transaction.ts';
import type { Connection, ReconcileDialect } from '../types.ts';

// This store's dialect (types.ts's ReconcileDialect) for the shared orchestration in
// store/reconcile.ts. content is FTS5-virtual with "_seg" sidecars for lexical.ts.

// SQLite's compile-time SQLITE_MAX_COLUMN, default 2000 (https://www.sqlite.org/limits.html).
const MAX_FRONTMATTER_COLUMNS = 2000;

// Shared by reconcileContent() and the tokenize-only rebuild in open.ts, so both prepare the
// same literal instead of two copies drifting apart.
export const INSERT_CONTENT_SQL = `INSERT INTO content (rowid, title, summary, text, "path", title_seg, summary_seg, text_seg) VALUES ((SELECT rowid FROM frontmatter WHERE "path" = ?), ?, ?, ?, ?, ?, ?, ?)`;

// A single content row's param tuple, matching INSERT_CONTENT_SQL's placeholder order.
// Assumes the frontmatter row for doc.relPath already exists (rowid subquery).
export function contentRow(doc: ParsedDoc): unknown[] {
  return [doc.relPath, doc.search.title, doc.search.summary, doc.search.text, doc.relPath, segmentField(doc.search.title), segmentField(doc.search.summary), segmentField(doc.search.text)];
}

async function reconcileContent(conn: Connection, touched: string[], docs: ParsedDoc[], _delta: ReconcileDelta, _cfg: Config): Promise<void> {
  // FTS5 has no upsert, so delete-before-insert, coupled to the frontmatter rowid (indexed via
  // its PRIMARY KEY) rather than the UNINDEXED `path` column, which a per-row DELETE would scan to find.
  // `touched` already covers a path a concurrent reconcile turned out to have created first --
  // see reconcile.ts's post-lock revalidation, which folds such paths in before calling here.
  if (touched.length > 0)
    await conn.runBatch(
      'DELETE FROM content WHERE rowid = (SELECT rowid FROM frontmatter WHERE "path" = ?)',
      touched.map((p) => [p])
    );

  if (docs.length > 0) await conn.runBatch(INSERT_CONTENT_SQL, docs.map(contentRow));
}

// SQLite's ADD COLUMN is metadata-only, so a loop costs nothing extra over one statement.
async function addColumns(conn: Connection, names: string[]): Promise<void> {
  for (const name of names) await conn.exec(`ALTER TABLE frontmatter ADD COLUMN ${quoteIdent(name)}`);
}

export const sqliteDialect: ReconcileDialect = {
  beginMode: () => BEGIN_WRITE,
  checkColumnLimit(count) {
    // Fence before ALTERing: SQLite's own failure past this point is a raw
    // "too many columns on sqlite_altertab_frontmatter" with no indication of the boundary or the levers.
    if (count > MAX_FRONTMATTER_COLUMNS) {
      throw new SenseError(
        'COLUMN_LIMIT',
        `frontmatter would need ${count} columns, crossing SQLite's compile-time SQLITE_MAX_COLUMN limit (default ${MAX_FRONTMATTER_COLUMNS}; see https://www.sqlite.org/limits.html). Narrow the presets' include globs so fewer/other files are indexed, or fix whatever is generating unbounded frontmatter keys.`
      );
    }
  },
  addColumns,
  reconcileContent,
  recordDuration: recordReconcileDuration,
};
