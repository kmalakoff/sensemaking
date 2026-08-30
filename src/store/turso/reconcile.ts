import type { Config } from '../../config/index.ts';
import { SenseError } from '../../errors.ts';
import { activeFeatures } from '../../features/index.ts';
import type { ExtractedDoc, ReconcileDelta } from '../../features/types.ts';
import { progress } from '../../output/progress.ts';
import type { ParsedDoc } from '../../scan/index.ts';
import { listFiles, RESERVED_COLUMNS } from '../../scan/index.ts';
import { reparseFiles } from '../../scan/reparse.ts';
import { getColumns, getMeta, quoteIdent, setMeta } from '../shared.ts';
import { withTransaction } from '../transaction.ts';
import type { Connection } from '../types.ts';

// Fork of sqlite/reconcile.ts (house precedent: each store owns its engine-specific SQL), not
// duckdb's, even though duckdb's content handling is the structurally closer of the two. duckdb
// dropped sqlite's reconcile_max_ms bookkeeping entirely, and this store's busy timeout (open.ts)
// is derived from exactly that recorded value -- forking duckdb's file would lose it silently.
// content itself follows duckdb's shape instead: a plain table, no rowid coupling, no FTS index
// (phase 2's job, not reconcile's), and no `_seg` sidecars (turso's unspaced-script path is not
// FTS5-shaped).
const CORE_FRONTMATTER_COLUMNS = new Set(['path', '_mtime', '_ctime', '_size', '_parse_error']);

// Not a compile-time cap on ALTER TABLE ADD COLUMN (spike-measured: turso accepts 10,000 with no
// error). The real fence is a SELECT projecting more than this many result columns, which fails
// to prepare (spike-measured, both `SELECT *` and an explicit list), so a wide frontmatter table
// would pass every write silently and only break the first time something selects across it.
// Enforced here, before ALTER, the same shape as sqlite's compile-time fence.
const MAX_FRONTMATTER_COLUMNS = 2000;

// No rowid coupling (unlike sqlite's FTS5 content): `path` is content's own primary key.
const INSERT_CONTENT_SQL = `INSERT INTO content ("path", title, summary, text) VALUES (?, ?, ?, ?)`;

function contentRow(doc: ParsedDoc): unknown[] {
  return [doc.relPath, doc.search.title, doc.search.summary, doc.search.text];
}

export async function reconcile(conn: Connection, cfg: Config, baseDir: string): Promise<{ parsed: number; warnings: string[] }> {
  const files = listFiles(cfg, baseDir);
  const currentSet = new Set(files.map((f) => f.relPath));

  const existingStmt = await conn.prepare('SELECT "path", "_mtime", "_size" FROM frontmatter');
  const existingRows = (await existingStmt.all()) as Array<{ path: string; _mtime: number; _size: number }>;
  const existing = new Map(existingRows.map((r) => [r.path, r]));
  const vanished = existingRows.filter((r) => !currentSet.has(r.path)).map((r) => r.path);

  const toReparse = files.filter((f) => {
    const row = existing.get(f.relPath);
    return !row || row._mtime !== f.mtimeMs || row._size !== f.size;
  });

  if (vanished.length === 0 && toReparse.length === 0) return { parsed: 0, warnings: [] };

  const features = activeFeatures(cfg);
  const seenColumns = await getColumns(conn);

  // Bulk reparses (a sync, a cold build) are the long silences a query can hit; short
  // reconciles stay silent (progress() has a threshold).
  const report = progress('reparsing files', toReparse.length);
  const { docs: parsedDocs, warnings, newColumns } = await reparseFiles(toReparse, features, cfg, seenColumns, report.tick);
  report.finish();
  for (const col of newColumns) seenColumns.add(col);

  const allColumns = [...seenColumns];
  if (allColumns.length > MAX_FRONTMATTER_COLUMNS) {
    throw new SenseError(
      'COLUMN_LIMIT',
      `frontmatter would need ${allColumns.length} columns, crossing turso's SELECT result-set column limit (${MAX_FRONTMATTER_COLUMNS}; ALTER TABLE ADD COLUMN itself accepts far more, but a query projecting past this many columns fails to prepare). Narrow the presets' include globs so fewer/other files are indexed, or fix whatever is generating unbounded frontmatter keys.`
    );
  }
  // Columns the frontmatter upsert actually writes: core + parsed frontmatter keys, never a
  // feature-owned reserved column (see CORE_FRONTMATTER_COLUMNS above).
  const writableColumns = allColumns.filter((c) => CORE_FRONTMATTER_COLUMNS.has(c) || !RESERVED_COLUMNS.has(c));
  // ON CONFLICT UPDATE (not OR REPLACE) keeps the row's identity stable across reparses.
  const insertSql = `INSERT INTO frontmatter (${writableColumns.map(quoteIdent).join(', ')}) VALUES (${writableColumns.map(() => '?').join(', ')}) ON CONFLICT("path") DO UPDATE SET ${writableColumns
    .filter((c) => c !== 'path')
    .map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`)
    .join(', ')}`;

  const added = toReparse.filter((f) => !existing.has(f.relPath)).map((f) => f.relPath);
  const delta: ReconcileDelta = { files, reparsed: parsedDocs.map((d) => d.relPath), added, vanished };
  const addedSet = new Set(added);
  const reparsedExisting = parsedDocs.map((d) => d.relPath).filter((p) => !addedSet.has(p));

  const txStart = Date.now();
  await withTransaction(conn, async () => {
    for (const col of newColumns) await conn.exec(`ALTER TABLE frontmatter ADD COLUMN ${quoteIdent(col)}`);

    if (parsedDocs.length > 0) {
      const rows = parsedDocs.map((doc) =>
        writableColumns.map((col) => {
          if (col === 'path') return doc.relPath;
          if (col === '_mtime') return doc.mtimeMs;
          if (col === '_ctime') return doc.ctimeMs;
          if (col === '_size') return doc.size;
          // Written per parse, unlike _rank, which a feature pass owns and the upsert skips.
          if (col === '_parse_error') return doc.parseError;
          return doc.data[col] ?? null;
        })
      );
      await conn.runBatch(insertSql, rows);
    }

    // content is a plain table keyed by its own path (no rowid subquery, unlike sqlite's FTS5
    // content), so vanished and reparsed docs delete in one pass.
    const contentTouched = [...vanished, ...reparsedExisting];
    if (contentTouched.length > 0)
      await conn.runBatch(
        'DELETE FROM content WHERE "path" = ?',
        contentTouched.map((p) => [p])
      );
    if (parsedDocs.length > 0) await conn.runBatch(INSERT_CONTENT_SQL, parsedDocs.map(contentRow));

    if (vanished.length > 0)
      await conn.runBatch(
        'DELETE FROM frontmatter WHERE "path" = ?',
        vanished.map((p) => [p])
      );

    // A preset edit forces a full rebuild, so an unchanged doc's coverage is already correct;
    // new docs have nothing to clear, which keeps cold builds linear.
    const presetTouched = [...vanished, ...reparsedExisting];
    if (presetTouched.length > 0)
      await conn.runBatch(
        'DELETE FROM preset_files WHERE "path" = ?',
        presetTouched.map((p) => [p])
      );
    const presetRows: unknown[][] = [];
    for (const doc of parsedDocs) for (const presetName of doc.presets) presetRows.push([doc.relPath, presetName]);
    if (presetRows.length > 0) await conn.runBatch('INSERT INTO preset_files ("path", preset) VALUES (?, ?)', presetRows);

    const removedPaths = [...vanished, ...reparsedExisting];
    if (removedPaths.length > 0) for (const feature of features) await feature.remove?.(conn, removedPaths, delta);
    for (const feature of features) {
      const docsForFeature: ExtractedDoc[] = parsedDocs.map((doc) => ({ path: doc.relPath, extracted: doc.extracted[feature.name] }));
      await feature.store?.(conn, docsForFeature, delta);
    }
    for (const feature of features) await feature.afterReconcile?.(conn, delta);
  });

  // Reconcile's own write-transaction duration, for open()'s derived busy_timeout: keep the
  // observed max so a big watcher reconcile's lock hold is what the next open bounds its wait
  // against (the same mechanism sqlite's reconcile records, and the one this store's busy
  // timeout is derived from).
  const durationMs = Date.now() - txStart;
  const prevRaw = await getMeta(conn, 'reconcile_max_ms');
  // -1, not 0, so a genuinely 0ms first reconcile (sub-millisecond, common on a tiny tree)
  // still gets recorded instead of losing to the "nothing recorded yet" default.
  const prevMax = prevRaw === null ? -1 : Number(prevRaw);
  if (durationMs > prevMax) await setMeta(conn, 'reconcile_max_ms', String(durationMs));

  return { parsed: parsedDocs.length, warnings };
}
