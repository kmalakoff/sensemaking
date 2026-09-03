import type { Config } from '../config/index.ts';
import { embed } from '../features/embed.ts';
import { FEATURES } from '../features/index.ts';
import { rank } from '../features/rank.ts';
import type { ReconcileDelta } from '../features/types.ts';
import { listFiles } from '../scan/index.ts';
import { ParsePool } from '../scan/pool.ts';
import { reparseFiles } from '../scan/reparse.ts';
import type { EmbedChangeKind } from './embed-scope.ts';
import type { FeatureToggle } from './feature-scope.ts';
import { NARROW_FEATURE_TABLE } from './feature-scope.ts';
import { reconcile } from './reconcile.ts';
import { getColumns } from './shared.ts';
import type { Stages } from './stages.ts';
import { withTransaction } from './transaction.ts';
import type { Connection, ReconcileDialect } from './types.ts';

// Owns bringing a store's index current: the write half `Store` (types.ts) deliberately does not
// carry. A one-shot open calls build() once; a watcher calls it repeatedly on the same instance.
export interface Builder {
  // forcedPaths (open.ts's preset-only narrow rebuild) applies to this call alone, not future ones.
  build(forcedPaths?: ReadonlySet<string>): Promise<{ parsed: number; warnings: string[]; stages: Stages }>;
  // Narrow embed invalidation (open.ts, embed-scope.ts's classifyEmbedChange): 'model' nulls every
  // vector/scale in place; 'chunk' rebuilds every embedding row. Neither touches another table.
  invalidate(kind: EmbedChangeKind): Promise<{ parsed: number }>;
  // Narrow feature-toggle invalidation (open.ts, feature-scope.ts's classifyFeatureToggles): a
  // toggle drops (or, turning back on, fully re-derives) that feature's own table; rank instead
  // nulls or recomputes its `_rank` column, since rows written while a feature was off are
  // untrustworthy (reconcile.ts's activeFeatures skips a disabled feature's hooks entirely).
  invalidateFeatures(toggles: FeatureToggle[]): Promise<{ parsed: number }>;
  // Releases the parse worker pool, if this lifetime ever created one; never the connection.
  close(): Promise<void>;
  // Pools this lifetime has constructed, so reuse is observable rather than inferred.
  readonly poolsCreated: number;
}

// 'model': the provider or model name moved but chunk boundaries did not, so only the vector
// values are stale. No reparse, and no table but embeddings is touched.
async function nullEmbedVectors(conn: Connection, dialect: ReconcileDialect): Promise<{ parsed: number }> {
  await withTransaction(conn, () => conn.exec('UPDATE embeddings SET vector = NULL, scale = NULL'), dialect.beginMode());
  return { parsed: 0 };
}

// 'chunk': chunkTokens or the chunk version moved, so chunk boundaries genuinely changed. Rebuilds
// every embedding row through the embed feature's own remove/store, touching no other table.
async function rebuildEmbeddings(conn: Connection, cfg: Config, baseDir: string, dialect: ReconcileDialect, pool: ParsePool): Promise<{ parsed: number }> {
  const existingStmt = await conn.prepare('SELECT "path" FROM frontmatter');
  const existingPaths = new Set((await existingStmt.all()).map((r) => (r as { path: string }).path));
  // A file added since the last build has no row yet; leaving it for build() to insert avoids a
  // primary-key collision between this INSERT and build()'s own insert for the same new file.
  const files = listFiles(cfg, baseDir).filter((f) => f.embed && existingPaths.has(f.relPath));
  if (files.length === 0) return { parsed: 0 };

  const { docs } = await reparseFiles(files, [embed], cfg, new Set(), undefined, { pool });
  const paths = docs.map((d) => d.relPath);
  const delta: ReconcileDelta = { files, reparsed: paths, added: [], vanished: [] };
  await withTransaction(
    conn,
    async () => {
      await embed.remove?.(conn, paths, delta);
      await embed.store?.(
        conn,
        docs.map((d) => ({ path: d.relPath, extracted: d.extracted.embed })),
        delta
      );
    },
    dialect.beginMode()
  );
  return { parsed: docs.length };
}

// One feature's own table, dropped and (turning on) fully re-derived across every indexed file.
// Rows left over from before this feature was disabled are untrustworthy by construction (files
// added, edited, or deleted got no remove/store for it), so this never diffs against them --
// dropping every row and reparsing the whole tree is the only safe path back to consistent state.
async function invalidateFeatureTable(conn: Connection, cfg: Config, baseDir: string, dialect: ReconcileDialect, pool: ParsePool, toggle: FeatureToggle): Promise<{ parsed: number }> {
  const table = NARROW_FEATURE_TABLE[toggle.name];
  const feature = FEATURES.find((f) => f.name === toggle.name);
  if (!feature) throw new Error(`invalidateFeatureTable: no registered feature named "${toggle.name}"`);

  if (!toggle.turnedOn) {
    await withTransaction(conn, () => conn.exec(`DELETE FROM ${table}`), dialect.beginMode());
    return { parsed: 0 };
  }

  const files = listFiles(cfg, baseDir);
  const { docs } = await reparseFiles(files, [feature], cfg, new Set(), undefined, { pool });
  const docsForFeature = docs.map((d) => ({ path: d.relPath, extracted: d.extracted[feature.name] }));
  const paths = docs.map((d) => d.relPath);
  // Every path counts as added, not just touched: the table was just dropped, so there is nothing
  // stale to diff against, and links' own afterReconcile takes its cold-build (resolveAll) path
  // only when added.length equals files.length.
  const delta: ReconcileDelta = { files, reparsed: paths, added: paths, vanished: [] };
  await withTransaction(
    conn,
    async () => {
      await conn.exec(`DELETE FROM ${table}`);
      await feature.store?.(conn, docsForFeature, delta);
      await feature.afterReconcile?.(conn, delta);
    },
    dialect.beginMode()
  );
  return { parsed: docs.length };
}

// rank has no table of its own: frontmatter._rank is the only state it owns. Guarded on column
// presence, since links can toggle off while rank has never been enabled for this tree.
async function nullRank(conn: Connection, dialect: ReconcileDialect): Promise<void> {
  const columns = await getColumns(conn);
  if (!columns.has('_rank')) return;
  await withTransaction(conn, () => conn.exec('UPDATE frontmatter SET "_rank" = NULL'), dialect.beginMode());
}

// Whole-tree and reparse-free: PageRank is computed from the links table, not from files, so
// turning rank back on needs no reparseFiles pass at all.
async function rerunRank(conn: Connection, dialect: ReconcileDialect): Promise<void> {
  const delta: ReconcileDelta = { files: [], reparsed: [], added: [], vanished: [] };
  await withTransaction(
    conn,
    async () => {
      await rank.afterReconcile?.(conn, delta);
    },
    dialect.beginMode()
  );
}

async function invalidateFeatureToggles(conn: Connection, cfg: Config, baseDir: string, dialect: ReconcileDialect, pool: ParsePool, toggles: FeatureToggle[]): Promise<{ parsed: number }> {
  const byName = new Map(toggles.map((toggle) => [toggle.name, toggle]));
  let parsed = 0;

  // links first, if present: rank's rerun below (whether from its own toggle or the co-change
  // rankToggle carries) must read the links table after it is back in its new state.
  const linksToggle = byName.get('links');
  if (linksToggle) {
    parsed += (await invalidateFeatureTable(conn, cfg, baseDir, dialect, pool, linksToggle)).parsed;
    // Unconditional, per rank's dependency on links: nulling is a no-op (guarded) when rank was
    // never enabled for this tree, so this is safe even when no feature:rank segment changed.
    if (!linksToggle.turnedOn) await nullRank(conn, dialect);
  }

  // rank's effective on/off (featureEnabled's links dependency) only appears as a changed
  // `feature:rank` segment when it actually flips -- whether that's rank's own config or a
  // links toggle taking it along -- so honoring it here is complete on its own.
  const rankToggle = byName.get('rank');
  if (rankToggle) {
    if (rankToggle.turnedOn) await rerunRank(conn, dialect);
    else await nullRank(conn, dialect);
  }

  for (const toggle of toggles) {
    if (toggle.name === 'links' || toggle.name === 'rank') continue;
    parsed += (await invalidateFeatureTable(conn, cfg, baseDir, dialect, pool, toggle)).parsed;
  }
  return { parsed };
}

// The pool is created at most once, lazily, on whichever build() or invalidate() call first
// needs it, and reused by every later call on this instance.
export function createBuilder(conn: Connection, cfg: Config, baseDir: string, dialect: ReconcileDialect): Builder {
  const pool = new ParsePool();
  return {
    build: (forcedPaths) => reconcile(conn, cfg, baseDir, dialect, pool, forcedPaths),
    invalidate: (kind) => (kind === 'model' ? nullEmbedVectors(conn, dialect) : rebuildEmbeddings(conn, cfg, baseDir, dialect, pool)),
    invalidateFeatures: (toggles) => invalidateFeatureToggles(conn, cfg, baseDir, dialect, pool, toggles),
    close: () => pool.close(),
    get poolsCreated() {
      return pool.poolsCreated;
    },
  };
}
