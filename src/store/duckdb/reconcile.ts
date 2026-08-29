import type { Config } from '../../config/index.ts';
import { SenseError } from '../../errors.ts';
import { activeFeatures } from '../../features/index.ts';
import type { ExtractedDoc, ReconcileDelta } from '../../features/types.ts';
import { progress } from '../../output/progress.ts';
import { listFiles, RESERVED_COLUMNS } from '../../scan/index.ts';
import { reparseFiles } from '../../scan/reparse.ts';
import { getColumns, quoteIdent } from '../shared.ts';
import { withTransaction } from '../transaction.ts';
import type { Connection } from '../types.ts';

// Mirrors src/store/sqlite/reconcile.ts's frontmatter-upsert shape (dynamic ALTER TABLE per
// discovered key, ON CONFLICT upsert keeping the row's identity stable) but with no `content`
// FTS table: this store has no lexical implementation this phase (see duckdb/store.ts). The one
// forced divergence is the ALTER TABLE type: DuckDB requires a declared column type where
// sqlite accepts none, so every dynamic frontmatter column is VARIANT (the only DuckDB type
// that can hold the different JS types mapValue() produces across files for the same key).
const CORE_FRONTMATTER_COLUMNS = new Set(['path', '_mtime', '_ctime', '_size', '_parse_error']);

// No compile-time column cap in DuckDB (unlike SQLite's SQLITE_MAX_COLUMN); kept as a sanity
// fence anyway so a runaway frontmatter generator fails with a clear message instead of an
// unbounded ALTER TABLE loop.
const MAX_FRONTMATTER_COLUMNS = 10_000;

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

  const report = progress('reparsing files', toReparse.length);
  const { docs: parsedDocs, warnings, newColumns } = reparseFiles(toReparse, features, cfg, seenColumns, report.tick);
  report.finish();
  for (const col of newColumns) seenColumns.add(col);

  const allColumns = [...seenColumns];
  if (allColumns.length > MAX_FRONTMATTER_COLUMNS) {
    throw new SenseError('COLUMN_LIMIT', `frontmatter would need ${allColumns.length} columns, crossing this store's sanity limit (${MAX_FRONTMATTER_COLUMNS}). Narrow the presets' include globs so fewer/other files are indexed, or fix whatever is generating unbounded frontmatter keys.`);
  }
  const writableColumns = allColumns.filter((c) => CORE_FRONTMATTER_COLUMNS.has(c) || !RESERVED_COLUMNS.has(c));
  const insertSql = `INSERT INTO frontmatter (${writableColumns.map(quoteIdent).join(', ')}) VALUES (${writableColumns.map(() => '?').join(', ')}) ON CONFLICT("path") DO UPDATE SET ${writableColumns
    .filter((c) => c !== 'path')
    .map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`)
    .join(', ')}`;

  const added = toReparse.filter((f) => !existing.has(f.relPath)).map((f) => f.relPath);
  const delta: ReconcileDelta = { files, reparsed: parsedDocs.map((d) => d.relPath), added, vanished };
  const addedSet = new Set(added);
  const reparsedExisting = parsedDocs.map((d) => d.relPath).filter((p) => !addedSet.has(p));

  await withTransaction(conn, async () => {
    // DuckDB's ALTER TABLE ADD COLUMN requires a type; VARIANT is the only one that can hold
    // the mixed bigint/number/string/null shapes mapValue() produces for one key across files.
    for (const col of newColumns) await conn.exec(`ALTER TABLE frontmatter ADD COLUMN ${quoteIdent(col)} VARIANT`);

    if (parsedDocs.length > 0) {
      const rows = parsedDocs.map((doc) =>
        writableColumns.map((col) => {
          if (col === 'path') return doc.relPath;
          if (col === '_mtime') return doc.mtimeMs;
          if (col === '_ctime') return doc.ctimeMs;
          if (col === '_size') return doc.size;
          if (col === '_parse_error') return doc.parseError;
          return doc.data[col] ?? null;
        })
      );
      await conn.runBatch(insertSql, rows);
    }

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

  return { parsed: parsedDocs.length, warnings };
}
