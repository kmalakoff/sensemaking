import { matchesGlob } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ResolvedConfig, SearchOverrides } from '../config/index.ts';
import { anyPresetEmbeds, resolveSearch } from '../config/index.ts';
import { columnHint } from '../output/column-hint.ts';

export const INTERNAL_COLUMNS = new Set(['path', '_mtime', '_ctime', '_size', '_rank', '_parse_error']);

// node:path's matchesGlob is experimental (stable behind an unstable-API flag) as of the
// engines floor (Node >=22.20); scope filtering only ever needs single-pattern matching, so
// it's used here in JS rather than running a directory walk in the query path.
export function inScope(path: string, include: string[], exclude?: string[]): boolean {
  if (!include.some((g) => matchesGlob(path, g))) return false;
  if (exclude?.some((g) => matchesGlob(path, g))) return false;
  return true;
}

export function scopeHasEmbeddings(db: DatabaseSync, cfg: ResolvedConfig, scopedPaths: Set<string>): boolean {
  if (!anyPresetEmbeds(cfg)) return false; // the embeddings table doesn't exist at all in this case
  const rows = db.prepare('SELECT DISTINCT "path" FROM embeddings').all() as Array<{ path: string }>;
  return rows.some((r) => scopedPaths.has(r.path));
}

// Scope only (no --where): preset_files for a named preset, JS glob matching for an ad hoc
// include/exclude override. Shared by scopedPaths() and search(), which also needs the
// pre-where set to size the candidate-pool filter.
export function rawScope(db: DatabaseSync, cfg: ResolvedConfig, overrides: SearchOverrides, allPaths?: string[]): Set<string> {
  const effective = resolveSearch(cfg, overrides);
  const { include, exclude } = effective;
  const adHocScope = overrides.include !== undefined || overrides.exclude !== undefined || overrides.noExclude === true;
  if (!adHocScope) return new Set((db.prepare('SELECT "path" FROM preset_files WHERE preset = ?').all(effective.presetName) as Array<{ path: string }>).map((r) => r.path));
  const paths = allPaths ?? (db.prepare('SELECT "path" FROM frontmatter').all() as Array<{ path: string }>).map((r) => r.path);
  return new Set(paths.filter((p) => inScope(p, include, exclude)));
}

export function narrowByWhere(db: DatabaseSync, paths: Set<string>, where: string | undefined): Set<string> {
  if (!where) return paths;
  let whereRows: Array<{ path: string }>;
  try {
    whereRows = db.prepare(`SELECT "path" FROM frontmatter f WHERE (${where})`).all() as Array<{ path: string }>;
  } catch (err) {
    throw columnHint(db, err as Error);
  }
  const wherePaths = new Set(whereRows.map((r) => r.path));
  return new Set([...paths].filter((p) => wherePaths.has(p)));
}

// The scope resolver for non-search commands (path, peek, map): same coverage rule search()
// applies, then narrowed by the resolved `where`.
export function scopedPaths(db: DatabaseSync, cfg: ResolvedConfig, overrides: SearchOverrides): Set<string> {
  const effective = resolveSearch(cfg, overrides);
  return narrowByWhere(db, rawScope(db, cfg, overrides), effective.where);
}

// Materializes a path set into a named temp table (same shape as traverse.ts's allowed_nodes)
// so a query can join/filter against it cheaply instead of binding a parameter per path.
export function materializeScope(db: DatabaseSync, table: string, paths: Set<string>): void {
  db.exec(`DROP TABLE IF EXISTS ${table}`);
  db.exec(`CREATE TEMP TABLE ${table} ("path" TEXT PRIMARY KEY)`);
  db.prepare(`INSERT INTO ${table} SELECT DISTINCT value FROM json_each(?1)`).run(JSON.stringify([...paths]));
}

export function setupMapScope(db: DatabaseSync, paths: Set<string>): void {
  materializeScope(db, '_map_scope', paths);
}
