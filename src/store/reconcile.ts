import type { Config } from '../config/index.ts';
import { activeFeatures } from '../features/index.ts';
import type { ExtractedDoc, ReconcileDelta } from '../features/types.ts';
import { progress } from '../output/progress.ts';
import { listFiles, RESERVED_COLUMNS } from '../scan/index.ts';
import type { ParsePool } from '../scan/pool.ts';
import { reparseFiles } from '../scan/reparse.ts';
import { recordLockWaitMs } from './lock-wait.ts';
import { appendRows, getColumns, quoteIdent } from './shared.ts';
import { featureStage, type StageRecorder, type Stages, stageRecorder } from './stages.ts';
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

export interface ReconcilePaths {
  rootDir: string;
  configDir: string;
}

export interface ReconcileSnapshot {
  existingRows: Array<{ path: string; _mtime: number; _size: number }>;
  seenColumns: Set<string>;
}

export interface ReconcilePlan {
  mutated: boolean;
  parsed: number;
  warnings: string[];
  apply(conn: Connection): Promise<void>;
  finish(txMs: number): Stages;
  record(conn: Connection, txMs: number): Promise<void>;
}

export interface ReconcileTiming {
  stages: StageRecorder;
  elapsed(): number;
  workerParseMs: number;
  txMs: number;
}

export function createReconcileTiming(cfg: Config): ReconcileTiming {
  const start = process.hrtime.bigint();
  return {
    stages: stageRecorder(activeFeatures(cfg).map((feature) => feature.name)),
    elapsed: () => Number(process.hrtime.bigint() - start) / 1e6,
    workerParseMs: 0,
    txMs: 0,
  };
}

// Called inside the builder's short planning snapshot, alongside its metadata baseline. Parsing
// happens only after that transaction closes; publication later rejects this state if generation
// or configuration moved in the meantime.
export async function readReconcileSnapshot(conn: Connection, timing: ReconcileTiming): Promise<ReconcileSnapshot> {
  const existingRows = await timing.stages.time('existing', async () => {
    const existingStmt = await conn.prepare('SELECT "path", "_mtime", "_size" FROM frontmatter');
    return (await existingStmt.all()) as ReconcileSnapshot['existingRows'];
  });
  return { existingRows, seenColumns: await getColumns(conn) };
}

export async function prepareReconcile(snapshot: ReconcileSnapshot, cfg: Config, paths: ReconcilePaths, dialect: ReconcileDialect, timing: ReconcileTiming, pool?: ParsePool, forcedPaths?: ReadonlySet<string>): Promise<ReconcilePlan> {
  const { rootDir, configDir } = paths;
  const features = activeFeatures(cfg);
  const { stages, elapsed } = timing;
  const files = await stages.time('list', () => listFiles(cfg, rootDir));
  const currentSet = new Set(files.map((f) => f.relPath));
  const existingRows = snapshot.existingRows;
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

  if (vanished.length === 0 && toReparse.length === 0) {
    return {
      mutated: false,
      parsed: 0,
      warnings: [],
      apply: async () => {},
      finish: (txMs) => stages.take(elapsed(), txMs, timing.workerParseMs),
      record: async () => {},
    };
  }

  const seenColumns = new Set(snapshot.seenColumns);

  // Bulk reparses (a sync, a cold build) are the long silences a query can hit; short
  // reconciles stay silent (progress() has a threshold).
  const report = progress('reparsing files', toReparse.length);
  // Pool wall time, dispatch to drain, so this stage shares a clock with every other one.
  const { docs: parsedDocs, warnings, newColumns, workerParseMs } = await stages.time('parse', () => reparseFiles(toReparse, features, cfg, seenColumns, report.tick, { pool }));
  timing.workerParseMs += workerParseMs;
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

  return {
    mutated: true,
    parsed: parsedDocs.length,
    warnings,
    async apply(conn) {
      // The generation fence already proved the planning snapshot current under this write lock.
      // Re-read columns only because schema setup is not itself a core generation publication.
      const present = await getColumns(conn);
      const missingColumns = newColumns.filter((col) => !present.has(col));
      if (missingColumns.length > 0) await stages.time('alter', () => dialect.addColumns(conn, missingColumns));

      if (parsedDocs.length > 0) {
        const toRow = (doc: (typeof parsedDocs)[number]) =>
          writableColumns.map((col) => {
            if (col === 'path') return doc.relPath;
            if (col === '_mtime') return doc.mtimeMs;
            if (col === '_ctime') return doc.ctimeMs;
            if (col === '_size') return doc.size;
            if (col === '_parse_error') return doc.parseError;
            return doc.data[col] ?? null;
          });
        await stages.time('fm-upsert', async () => {
          const newDocs = parsedDocs.filter((d) => addedSet.has(d.relPath));
          const updateDocs = parsedDocs.filter((d) => !addedSet.has(d.relPath));
          await appendRows(conn, 'frontmatter', writableColumns, insertSql, newDocs.map(toRow));
          if (updateDocs.length > 0) {
            const rows = updateDocs.map(toRow);
            if (dialect.updateFrontmatter) await dialect.updateFrontmatter(conn, writableColumns, rows);
            else await conn.runBatch(insertSql, rows);
          }
        });
      }

      await stages.time('text-index', () => dialect.reconcileContent(conn, touched, parsedDocs, delta, cfg));
      if (touched.length > 0)
        await conn.runBatch(
          'DELETE FROM indexed_sources WHERE "path" = ?',
          touched.map((p) => [p])
        );
      await appendRows(
        conn,
        'indexed_sources',
        ['path', 'text'],
        'INSERT INTO indexed_sources ("path", text) VALUES (?, ?) ON CONFLICT("path") DO UPDATE SET text = excluded.text',
        parsedDocs.map((doc) => [doc.relPath, doc.source])
      );

      await stages.time('presets', async () => {
        if (touched.length > 0)
          await conn.runBatch(
            'DELETE FROM preset_files WHERE "path" = ?',
            touched.map((p) => [p])
          );
        const presetRows: unknown[][] = [];
        for (const doc of parsedDocs) for (const presetName of doc.presets) presetRows.push([doc.relPath, presetName]);
        await appendRows(conn, 'preset_files', ['path', 'preset'], 'INSERT INTO preset_files ("path", preset) VALUES (?, ?) ON CONFLICT("path", preset) DO NOTHING', presetRows);
      });

      if (vanished.length > 0)
        await stages.time('vanished', () =>
          conn.runBatch(
            'DELETE FROM frontmatter WHERE "path" = ?',
            vanished.map((p) => [p])
          )
        );

      if (touched.length > 0) for (const feature of features) await stages.time(featureStage(feature.name, 'remove'), () => feature.remove?.(conn, touched, delta));
      for (const feature of features) {
        const docsForFeature: ExtractedDoc[] = parsedDocs.map((doc) => ({ path: doc.relPath, extracted: doc.extracted[feature.name] }));
        await stages.time(featureStage(feature.name, 'store'), () => feature.store?.(conn, docsForFeature, delta));
      }
      for (const feature of features) await stages.time(featureStage(feature.name, 'after'), () => feature.afterReconcile?.(conn, delta));
    },
    finish: (txMs) => stages.take(elapsed(), txMs, timing.workerParseMs),
    async record(conn, txMs) {
      recordLockWaitMs(configDir, txMs);
      if (dialect.recordDuration) await stages.time('meta', () => dialect.recordDuration?.(conn, txMs));
    },
  };
}

// Lower-level entrypoint retained only for focused reconcile tests. It has no generation fence;
// production publication must go through builder.ts, and any new caller must provide exclusivity.
export async function reconcile(conn: Connection, cfg: Config, paths: ReconcilePaths, dialect: ReconcileDialect, pool?: ParsePool, forcedPaths?: ReadonlySet<string>): Promise<{ parsed: number; warnings: string[]; stages: Stages }> {
  const timing = createReconcileTiming(cfg);
  const snapshot = await withTransaction(conn, () => readReconcileSnapshot(conn, timing));
  const plan = await prepareReconcile(snapshot, cfg, paths, dialect, timing, pool, forcedPaths);
  if (!plan.mutated) return { parsed: plan.parsed, warnings: plan.warnings, stages: plan.finish(0) };
  const txStart = Date.now();
  let txMs: number;
  try {
    await withTransaction(conn, () => plan.apply(conn), dialect.beginMode());
  } finally {
    txMs = Date.now() - txStart;
    timing.txMs += txMs;
  }
  await plan.record(conn, txMs);
  return { parsed: plan.parsed, warnings: plan.warnings, stages: plan.finish(timing.txMs) };
}
