import type { Config } from '../config/index.ts';
import { activeFeatures } from '../features/index.ts';
import type { ExtractedDoc, ReconcileDelta } from '../features/types.ts';
import { progress } from '../output/progress.ts';
import { listFiles, RESERVED_COLUMNS } from '../scan/index.ts';
import type { ParsePool } from '../scan/pool.ts';
import { reparseFiles } from '../scan/reparse.ts';
import { getColumns, quoteIdent } from './shared.ts';
import { featureStage, type Stages, stageRecorder } from './stages.ts';
import { withTransaction } from './transaction.ts';
import type { Connection, ReconcileDialect } from './types.ts';

// One reconcile algorithm shared by every store, parameterised by a per-engine ReconcileDialect
// (types.ts). Ordering is universal, not a dialect concern: ALTER, then the frontmatter upsert,
// then reconcileContent, then preset_files, then the vanished-frontmatter delete, then feature hooks
// -- a vanished path's content delete (inside reconcileContent) must precede its frontmatter
// delete, since sqlite's delete SQL resolves the row via its frontmatter rowid.

// Feature-owned columns (`_rank`) must stay out of the upsert: a reparse would null the last
// computed value on every touch, not just the reconciles that recompute it.
export const CORE_FRONTMATTER_COLUMNS = new Set(['path', '_mtime', '_ctime', '_size', '_parse_error']);

export async function reconcile(conn: Connection, cfg: Config, baseDir: string, dialect: ReconcileDialect, pool?: ParsePool, forcedPaths?: ReadonlySet<string>): Promise<{ parsed: number; warnings: string[]; stages: Stages }> {
  const start = process.hrtime.bigint();
  const features = activeFeatures(cfg);
  const stages = stageRecorder(features.map((f) => f.name));
  const elapsed = () => Number(process.hrtime.bigint() - start) / 1e6;
  const files = await stages.time('list', () => listFiles(cfg, baseDir));
  const currentSet = new Set(files.map((f) => f.relPath));

  const existingRows = await stages.time('existing', async () => {
    const existingStmt = await conn.prepare('SELECT "path", "_mtime", "_size" FROM frontmatter');
    return (await existingStmt.all()) as Array<{ path: string; _mtime: number; _size: number }>;
  });
  const existing = new Map(existingRows.map((r) => [r.path, r]));
  // A path whose coverage moved between presets (forcedPaths) but is no longer covered at all is
  // already caught below by !currentSet.has, since it can only be forced by having existed under
  // an old preset's match, which means it was reconciled into `existing` already.
  const vanished = existingRows.filter((r) => !currentSet.has(r.path)).map((r) => r.path);

  // forcedPaths treats an unchanged file as touched because its preset coverage moved, not its
  // stamp -- reconcile still owns add/update/remove and every cross-feature cascade for it.
  const toReparse = files.filter((f) => {
    const row = existing.get(f.relPath);
    return !row || row._mtime !== f.mtimeMs || row._size !== f.size || (forcedPaths?.has(f.relPath) ?? false);
  });

  if (vanished.length === 0 && toReparse.length === 0) return { parsed: 0, warnings: [], stages: stages.take(elapsed(), 0) };

  const seenColumns = await getColumns(conn);

  // Bulk reparses (a sync, a cold build) are the long silences a query can hit; short
  // reconciles stay silent (progress() has a threshold).
  const report = progress('reparsing files', toReparse.length);
  // Pool wall time, dispatch to drain, so this stage shares a clock with every other one.
  const { docs: parsedDocs, warnings, newColumns } = await stages.time('parse', () => reparseFiles(toReparse, features, cfg, seenColumns, report.tick, { pool }));
  report.finish();
  for (const col of newColumns) seenColumns.add(col);

  const allColumns = [...seenColumns];
  // Fence before ALTERing: a store's own failure past this point is a raw, engine-specific
  // error with no indication of the boundary or the levers -- dialect.checkColumnLimit names both.
  dialect.checkColumnLimit(allColumns.length);
  // Columns the frontmatter upsert actually writes: core + parsed frontmatter keys, never a
  // feature-owned reserved column (see CORE_FRONTMATTER_COLUMNS above).
  const writableColumns = allColumns.filter((c) => CORE_FRONTMATTER_COLUMNS.has(c) || !RESERVED_COLUMNS.has(c));
  // ON CONFLICT DO UPDATE (not OR REPLACE) keeps the row's rowid stable across reparses --
  // sqlite's content rows are coupled to that rowid.
  const insertSql = `INSERT INTO frontmatter (${writableColumns.map(quoteIdent).join(', ')}) VALUES (${writableColumns.map(() => '?').join(', ')}) ON CONFLICT("path") DO UPDATE SET ${writableColumns
    .filter((c) => c !== 'path')
    .map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`)
    .join(', ')}`;

  const added = toReparse.filter((f) => !existing.has(f.relPath)).map((f) => f.relPath);
  const delta: ReconcileDelta = { files, reparsed: parsedDocs.map((d) => d.relPath), added, vanished };
  const addedSet = new Set(added);
  const reparsedExisting = parsedDocs.map((d) => d.relPath).filter((p) => !addedSet.has(p));
  // Paths whose content (and, per feature, other rows) need clearing: gone entirely, or about to
  // be reinserted fresh. Disjoint from `added`, which has nothing to clear.
  const touched = [...vanished, ...reparsedExisting];

  const txStart = Date.now();
  await withTransaction(
    conn,
    async () => {
      // Re-read inside the write transaction: newColumns came from a read taken before it opened, so a
      // concurrent reconcile may have added some of them since. ALTER has no IF NOT EXISTS.
      const present = await getColumns(conn);
      const missingColumns = newColumns.filter((col) => !present.has(col));
      if (missingColumns.length > 0) await stages.time('alter', () => dialect.addColumns(conn, missingColumns));

      // Revalidated once the lock is held, before this process's own frontmatter upsert below:
      // `added` came from a path read taken before this transaction's lock, so a path still
      // called "added" here may already have a content row from a concurrent reconcile that
      // committed while this one waited. One SELECT, not a DELETE per added file -- with no
      // contention it returns the same set `existing` already ruled out, so nothing extra clears.
      let contentTouched = touched;
      if (added.length > 0)
        contentTouched = await stages.time('added-recheck', async () => {
          const currentPathsStmt = await conn.prepare('SELECT "path" FROM frontmatter');
          const currentPaths = new Set(((await currentPathsStmt.all()) as Array<{ path: string }>).map((r) => r.path));
          const staleAdded = added.filter((p) => currentPaths.has(p));
          return staleAdded.length > 0 ? [...touched, ...staleAdded] : touched;
        });

      if (parsedDocs.length > 0) {
        const toRow = (doc: (typeof parsedDocs)[number]) =>
          writableColumns.map((col) => {
            if (col === 'path') return doc.relPath;
            if (col === '_mtime') return doc.mtimeMs;
            if (col === '_ctime') return doc.ctimeMs;
            if (col === '_size') return doc.size;
            // Written per parse, unlike _rank, which a feature pass owns and the upsert skips.
            if (col === '_parse_error') return doc.parseError;
            return doc.data[col] ?? null;
          });
        // A path in `added` has no existing frontmatter row, so it can never conflict: where a
        // dialect offers a faster append-only path (insertNew), only the rest go through the upsert.
        await stages.time('fm-upsert', async () => {
          if (dialect.insertNew) {
            const newDocs = parsedDocs.filter((d) => addedSet.has(d.relPath));
            const updateDocs = parsedDocs.filter((d) => !addedSet.has(d.relPath));
            if (newDocs.length > 0) await dialect.insertNew(conn, 'frontmatter', writableColumns, newDocs.map(toRow));
            if (updateDocs.length > 0) await conn.runBatch(insertSql, updateDocs.map(toRow));
          } else {
            await conn.runBatch(insertSql, parsedDocs.map(toRow));
          }
        });
      }

      // After the upsert, so every doc already has the frontmatter row sqlite's content rowid
      // couples to. ON CONFLICT DO UPDATE preserves that rowid, so a reparse keeps its identity.
      await stages.time('text-index', () => dialect.reconcileContent(conn, contentTouched, parsedDocs, delta, cfg));

      // A preset edit forces a full rebuild, so an unchanged doc's coverage is already correct;
      // new docs have nothing to clear, which keeps cold builds linear.
      await stages.time('presets', async () => {
        if (touched.length > 0)
          await conn.runBatch(
            'DELETE FROM preset_files WHERE "path" = ?',
            touched.map((p) => [p])
          );
        const presetRows: unknown[][] = [];
        for (const doc of parsedDocs) for (const presetName of doc.presets) presetRows.push([doc.relPath, presetName]);
        // DO NOTHING, not a bare INSERT: the added/touched split above comes from a read taken
        // before this transaction's lock, so a path this process calls "added" can already have
        // its (path, preset) row committed by a concurrent reconcile -- the row would be identical either way.
        if (presetRows.length > 0) await conn.runBatch('INSERT INTO preset_files ("path", preset) VALUES (?, ?) ON CONFLICT("path", preset) DO NOTHING', presetRows);
      });

      // Before the feature hooks, never after: rank's afterReconcile reads frontmatter as PageRank's
      // node set, so a lingering vanished row would dilute rank mass across every surviving note.
      if (vanished.length > 0)
        await stages.time('vanished', () =>
          conn.runBatch(
            'DELETE FROM frontmatter WHERE "path" = ?',
            vanished.map((p) => [p])
          )
        );

      // Timed per feature per hook, so link resolution and PageRank are named stages without
      // links.ts or rank.ts knowing anything about this, and a new feature is visible for free.
      if (touched.length > 0) for (const feature of features) await stages.time(featureStage(feature.name, 'remove'), () => feature.remove?.(conn, touched, delta));
      for (const feature of features) {
        const docsForFeature: ExtractedDoc[] = parsedDocs.map((doc) => ({ path: doc.relPath, extracted: doc.extracted[feature.name] }));
        await stages.time(featureStage(feature.name, 'store'), () => feature.store?.(conn, docsForFeature, delta));
      }
      for (const feature of features) await stages.time(featureStage(feature.name, 'after'), () => feature.afterReconcile?.(conn, delta));
    },
    dialect.beginMode()
  );

  const durationMs = Date.now() - txStart;
  if (dialect.recordDuration) await stages.time('meta', () => dialect.recordDuration?.(conn, durationMs));

  return { parsed: parsedDocs.length, warnings, stages: stages.take(elapsed(), durationMs) };
}
