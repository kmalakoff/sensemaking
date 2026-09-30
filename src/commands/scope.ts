import { matchesGlob } from 'node:path';
import type { ResolvedConfig, SearchOverrides } from '../config/index.ts';
import { anyPresetEmbeds, resolveSearch } from '../config/index.ts';
import { columnHint } from '../output/column-hint.ts';
import type { Store } from '../store/types.ts';
import { NATIVE_VECTOR_SCOPE_TABLE, reserveNativeVectorScope } from '../store/vectors.ts';

export const INTERNAL_COLUMNS = new Set(['path', '_mtime', '_ctime', '_size', '_rank', '_parse_error']);

// node:path's matchesGlob is experimental (stable behind an unstable-API flag) at the
// Node >=22.20 engines floor; used here in JS rather than a directory walk in the query path.
export function inScope(path: string, include: string[], exclude?: string[]): boolean {
  if (!include.some((g) => matchesGlob(path, g))) return false;
  if (exclude?.some((g) => matchesGlob(path, g))) return false;
  return true;
}

export async function scopeHasEmbeddings(store: Store, cfg: ResolvedConfig, scopedPaths: Set<string>): Promise<boolean> {
  if (!anyPresetEmbeds(cfg)) return false; // the embeddings table doesn't exist at all in this case
  const stmt = await store.prepare('SELECT DISTINCT "path" FROM embeddings WHERE vector IS NOT NULL');
  const rows = (await stmt.all()) as Array<{ path: string }>;
  return rows.some((r) => scopedPaths.has(r.path));
}

// Scope only (no --where): preset_files for a named preset, JS glob matching for an ad hoc
// include/exclude override. Shared by scopedPaths() and search()'s candidate-pool sizing.
export async function rawScope(store: Store, cfg: ResolvedConfig, overrides: SearchOverrides, allPaths?: string[]): Promise<Set<string>> {
  const effective = resolveSearch(cfg, overrides);
  const { include, exclude } = effective;
  const adHocScope = overrides.include !== undefined || overrides.exclude !== undefined || overrides.noExclude === true;
  if (!adHocScope) {
    const stmt = await store.prepare('SELECT "path" FROM preset_files WHERE preset = ?');
    return new Set(((await stmt.all(effective.presetName)) as Array<{ path: string }>).map((r) => r.path));
  }
  const paths = allPaths ?? (await allFrontmatterPaths(store));
  return new Set(paths.filter((p) => inScope(p, include, exclude)));
}

async function allFrontmatterPaths(store: Store): Promise<string[]> {
  const stmt = await store.prepare('SELECT "path" FROM frontmatter');
  return ((await stmt.all()) as Array<{ path: string }>).map((r) => r.path);
}

export async function narrowByWhere(store: Store, paths: Set<string>, where: string | undefined): Promise<Set<string>> {
  if (!where) return paths;
  let whereRows: Array<{ path: string }>;
  try {
    const stmt = await store.prepare(`SELECT "path" FROM frontmatter f WHERE (${where})`);
    whereRows = (await stmt.all()) as Array<{ path: string }>;
  } catch (err) {
    throw columnHint(await store.docs.columns(), err as Error);
  }
  const wherePaths = new Set(whereRows.map((r) => r.path));
  return new Set([...paths].filter((p) => wherePaths.has(p)));
}

// The scope resolver for non-search commands (path, peek, map): same coverage rule search()
// applies, then narrowed by the resolved `where`.
export async function scopedPaths(store: Store, cfg: ResolvedConfig, overrides: SearchOverrides): Promise<Set<string>> {
  const effective = resolveSearch(cfg, overrides);
  return narrowByWhere(store, await rawScope(store, cfg, overrides), effective.where);
}

// Materializes a path set into a named temp table (same shape as traverse.ts's allowed_nodes)
// so a query can join/filter against it cheaply instead of binding a parameter per path.
export async function materializeScope(store: Store, table: string, paths: Set<string>): Promise<void> {
  await store.exec(`DROP TABLE IF EXISTS ${table}`);
  await store.exec(`CREATE TEMP TABLE ${table} ("path" TEXT PRIMARY KEY)`);
  await store.runBatch(
    `INSERT INTO ${table} ("path") VALUES (?)`,
    [...paths].map((p) => [p])
  );
}

// Native vector adapters can consume a small exact scope through their connection-local temp
// table. The reservation is tied to this Store's VectorStore wrapper, so another Store cannot
// activate it by receiving the same Set object.
export async function withMaterializedVectorScope<T>(store: Store, allowed: Set<string>, callback: () => Promise<T>, knownTotal?: number): Promise<T> {
  const reservation = reserveNativeVectorScope(store.vectors, allowed);
  if (!reservation) return callback();

  if (allowed.size === 0) {
    reservation.invalidate();
    return callback();
  }

  let total = knownTotal;
  if (total === undefined) {
    try {
      const stmt = await store.prepare('SELECT COUNT(*) AS count FROM frontmatter');
      const row = (await stmt.get()) as { count: number | bigint };
      total = Number(row.count);
    } catch (err) {
      reservation.invalidate();
      throw err;
    }
  }
  // Materialization only buys work when this is a nonempty true narrowing and the allowed side
  // is no larger than its complement. Direct adapter calls and broader scopes retain JS filtering.
  if (allowed.size >= total || allowed.size > total - allowed.size) {
    reservation.invalidate();
    return callback();
  }

  let operationFailed = false;
  let operationError: unknown;
  let result!: T;
  try {
    await materializeScope(store, NATIVE_VECTOR_SCOPE_TABLE, allowed);
    reservation.activate();
    result = await callback();
  } catch (err) {
    operationFailed = true;
    operationError = err;
  }

  let cleanupFailed = false;
  let cleanupError: unknown;
  try {
    reservation.deactivate();
    await store.exec(`DROP TABLE IF EXISTS ${NATIVE_VECTOR_SCOPE_TABLE}`);
  } catch (err) {
    cleanupFailed = true;
    cleanupError = err;
  } finally {
    reservation.invalidate();
  }

  if (operationFailed && cleanupFailed) throw new AggregateError([operationError, cleanupError], 'native vector scope operation and cleanup failed');
  if (operationFailed) throw operationError;
  if (cleanupFailed) throw cleanupError;
  return result;
}

export async function setupMapScope(store: Store, paths: Set<string>): Promise<void> {
  await materializeScope(store, '_map_scope', paths);
}
