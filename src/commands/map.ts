import type { DatabaseSync } from 'node:sqlite';
import type { FeatureName, ResolvedConfig, SearchOverrides } from '../config/index.ts';
import { featureEnabled, featureStates } from '../config/index.ts';
import type { Row } from '../output.ts';
import { INTERNAL_COLUMNS, scopedPaths, setupMapScope } from './scope.ts';
import type { PresetCoverage } from './status.ts';
import { presetCoverage } from './status.ts';

export interface TreeMap {
  docs: { count: number; bytes: number };
  fields: Row[]; // top 20 by coverage; fieldsTotal carries the real count
  fieldsTotal: number;
  features: { on: FeatureName[]; off: FeatureName[] };
  presets: PresetCoverage[];
  hubs: Row[];
  recent: Row[];
  recentCaveat: string | null;
}

// A result row is capped at SQLITE_MAX_COLUMN (2000, default); two aggregate expressions
// per field keeps a chunk's row safely under that regardless of how many fields the tree has.
const MAP_COLUMN_CHUNK = 300;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// What is this scope: fixed-size output regardless of tree size. Coverage and features stay
// global -- they describe the tree, not the current question.
export function mapTree(db: DatabaseSync, cfg: ResolvedConfig, overrides: SearchOverrides = {}): TreeMap {
  setupMapScope(db, scopedPaths(db, cfg, overrides));
  const scopeWhere = 'WHERE "path" IN (SELECT "path" FROM _map_scope)';
  const scopeAnd = 'AND f."path" IN (SELECT "path" FROM _map_scope)';

  const docs = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM("_size"), 0) AS bytes FROM frontmatter ${scopeWhere}`).get() as { count: number; bytes: number };

  const columns = (db.prepare('PRAGMA table_info(frontmatter)').all() as Array<{ name: string }>).map((r) => r.name).filter((name) => !INTERNAL_COLUMNS.has(name));
  // Observed types, not declared: SQLite types per value, so a field can be text in most notes
  // and numeric in a few. One aggregate scan per chunk of columns; FILTER matches COUNT's nulls.
  const allFields: Row[] = [];
  for (const group of chunk(columns, MAP_COLUMN_CHUNK)) {
    const exprs = group.map((name, i) => {
      const quoted = `"${name.split('"').join('""')}"`;
      return `COUNT(${quoted}) AS n${i}, GROUP_CONCAT(DISTINCT typeof(${quoted})) FILTER (WHERE ${quoted} IS NOT NULL) AS t${i}`;
    });
    const result = db.prepare(`SELECT ${exprs.join(', ')} FROM frontmatter ${scopeWhere}`).get() as Record<string, number | string | null>;
    group.forEach((name, i) => allFields.push({ field: name, coverage: result[`n${i}`] as number, type: (result[`t${i}`] as string) ?? '' }));
  }
  allFields.sort((a, b) => (b.coverage as number) - (a.coverage as number));
  const fields = allFields.slice(0, 20);

  const hubs = featureEnabled(cfg, 'rank') ? (db.prepare(`SELECT f."path" AS path, round(f."_rank" * 100, 2) AS rank, content.title FROM frontmatter f JOIN content ON content.path = f."path" WHERE f."_rank" IS NOT NULL ${scopeAnd} ORDER BY f."_rank" DESC LIMIT 8`).all() as Row[]) : [];

  const recent = db.prepare(`SELECT "path", datetime("_mtime" / 1000, 'unixepoch') AS modified FROM frontmatter ${scopeWhere} ORDER BY "_mtime" DESC LIMIT 5`).all() as Row[];

  // A fresh clone/copy stamps files with checkout time, not edit history; second granularity
  // matches the `recent` table above and is coarse enough to catch that without an exact-ms match.
  const topSecond = db.prepare(`SELECT COUNT(*) AS n FROM frontmatter ${scopeWhere} GROUP BY CAST("_mtime" / 1000 AS INTEGER) ORDER BY n DESC LIMIT 1`).get() as { n: number } | undefined;
  const recentCaveat = topSecond && docs.count > 1 && topSecond.n > docs.count / 2 ? `${topSecond.n} of ${docs.count} files share one modified second, so recency likely reflects a checkout or copy, not edit history` : null;

  return { docs, fields, fieldsTotal: allFields.length, features: featureStates(cfg), presets: presetCoverage(db, cfg), hubs, recent, recentCaveat };
}
