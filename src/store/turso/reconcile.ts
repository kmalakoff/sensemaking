import { SenseError } from '../../errors.ts';
import type { ReconcileDelta } from '../../features/types.ts';
import type { ParsedDoc } from '../../scan/index.ts';
import { hasUnspacedRun } from '../../text/segment.ts';
import { quoteIdent, recordReconcileDuration } from '../shared.ts';
import { BEGIN_WRITE } from '../transaction.ts';
import type { Connection, ReconcileDialect } from '../types.ts';

// This store's dialect (types.ts's ReconcileDialect) for the shared orchestration in
// store/reconcile.ts. content is a plain table with "_ngram" sidecars for lexical.ts.

// The ngram index is scoped to disjoint "_ngram" sidecar columns: a second index over the same
// columns makes a bare substring match a whole word, defeating the prefix-query rejection.
// The two FTS indexes, named here (not open.ts) because reconcile drops and rebuilds them around
// a bulk load: Tantivy maintains them per inserted row, which is quadratic in what is already indexed.
export const CONTENT_FTS_DDL = [
  `CREATE INDEX IF NOT EXISTS content_fts ON content USING fts (title, summary, text) WITH (weights = 'title=10.0,summary=5.0,text=1.0')`,
  `CREATE INDEX IF NOT EXISTS content_fts_ngram ON content USING fts (title_ngram, summary_ngram, text_ngram) WITH (tokenizer='ngram', weights='title_ngram=10.0,summary_ngram=5.0,text_ngram=1.0')`,
] as const;
export const CONTENT_FTS_NAMES = ['content_fts', 'content_fts_ngram'] as const;

// '' when the field has no unspaced-script run (the common case), so the ngram index carries
// nothing for it -- same "pay for nothing when absent" shape as sqlite's segmentField sidecars.
function ngramSidecar(text: string): string {
  return hasUnspacedRun(text) ? text : '';
}

// Not a compile-time cap on ALTER TABLE ADD COLUMN (spike-measured: turso accepts 10,000 with
// no error); the real fence is a SELECT projecting more than this many result columns, which fails to prepare.
const MAX_FRONTMATTER_COLUMNS = 2000;

// Changed files above which rebuilding the FTS index beats maintaining it per row. Measured
// 2026-08-30; the derivation and its bounds are pinned in this file's spec.
export const FTS_REBUILD_THRESHOLD = 250;

// No rowid coupling (unlike sqlite's FTS5 content): `path` is content's own primary key.
const INSERT_CONTENT_SQL = `INSERT INTO content ("path", title, summary, text, title_ngram, summary_ngram, text_ngram) VALUES (?, ?, ?, ?, ?, ?, ?)`;

function contentRow(doc: ParsedDoc): unknown[] {
  const { title, summary, text } = doc.search;
  return [doc.relPath, title, summary, text, ngramSidecar(title), ngramSidecar(summary), ngramSidecar(text)];
}

async function reconcileContent(conn: Connection, touched: string[], docs: ParsedDoc[], delta: ReconcileDelta): Promise<void> {
  const churn = delta.reparsed.length + delta.vanished.length;

  // Tantivy indexes per inserted row at a cost that grows with the batch, so a large insert is
  // superlinear and a rebuild wins past the threshold.
  const bulk = delta.files.length === 0 || churn > FTS_REBUILD_THRESHOLD;
  if (bulk) for (const name of CONTENT_FTS_NAMES) await conn.exec(`DROP INDEX IF EXISTS ${name}`);

  // content is a plain table keyed by its own path (no rowid subquery, unlike sqlite's FTS5
  // content), so vanished and reparsed docs delete in one pass.
  if (touched.length > 0)
    await conn.runBatch(
      'DELETE FROM content WHERE "path" = ?',
      touched.map((p) => [p])
    );
  if (docs.length > 0) await conn.runBatch(INSERT_CONTENT_SQL, docs.map(contentRow));
  if (bulk) for (const ddl of CONTENT_FTS_DDL) await conn.exec(ddl);
}

// turso's ADD COLUMN is metadata-only, so a loop costs nothing extra over one statement.
async function addColumns(conn: Connection, names: string[]): Promise<void> {
  for (const name of names) await conn.exec(`ALTER TABLE frontmatter ADD COLUMN ${quoteIdent(name)}`);
}

export const tursoDialect: ReconcileDialect = {
  beginMode: () => BEGIN_WRITE,
  checkColumnLimit(count) {
    if (count > MAX_FRONTMATTER_COLUMNS) {
      throw new SenseError(
        'COLUMN_LIMIT',
        `frontmatter would need ${count} columns, crossing turso's SELECT result-set column limit (${MAX_FRONTMATTER_COLUMNS}; ALTER TABLE ADD COLUMN itself accepts far more, but a query projecting past this many columns fails to prepare). Narrow the presets' include globs so fewer/other files are indexed, or fix whatever is generating unbounded frontmatter keys.`
      );
    }
  },
  addColumns,
  reconcileContent,
  recordDuration: recordReconcileDuration,
};
