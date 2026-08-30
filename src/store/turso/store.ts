import type { Database } from '@tursodatabase/database';
import type { Config } from '../../config/index.ts';
import { SenseError } from '../../errors.ts';
import { getColumns } from '../shared.ts';
import { withTransaction } from '../transaction.ts';
import type { Capability, Connection, Statement, Store } from '../types.ts';
import { hasVectorRow, pendingRows } from '../vectors.ts';
import { fieldStats } from './fieldStats.ts';
import { reconcile } from './reconcile.ts';

// Phase 1: the portable surface only -- frontmatter, links, sections, tags, rank, raw SQL,
// reconcile, transactions. Neither lexical (Tantivy FTS) nor vectors (native vector_distance_cos
// scans) is claimed yet -- phase 2 and phase 3 of the plan add them -- so lexical.query() and the
// vector-math methods throw the named capability error rather than answer differently.
// pending()/hasVector() are plain IS NULL/IS NOT NULL checks with no engine-specific math, so
// they're wired through the same store-agnostic helpers duckdb's store.ts reuses: harmless ahead
// of phase 3 (unreachable in practice, since openStore() already rejects a turso tree whose
// config uses vectors) and correct with no further change once vectors land.
export const CAPABILITIES: ReadonlySet<Capability> = new Set();

function missing(name: 'lexical' | 'vectors'): never {
  throw new SenseError('STORE_CAPABILITY_MISSING', `store "turso" does not implement "${name}" in this build; set "store" to "sqlite" or "duckdb" in this tree's config`);
}

// Shares one Connection instance (conn) with open()'s own reconcile call so transaction depth
// (see transaction.ts) is tracked against the same object everywhere.
export function createStore(db: Database, conn: Connection, cfg: Config, baseDir: string): Store {
  return {
    name: 'turso',
    capabilities: CAPABILITIES,
    async exec(sql: string): Promise<void> {
      await conn.exec(sql);
    },
    async prepare(sql: string): Promise<Statement> {
      return conn.prepare(sql);
    },
    async runBatch(sql: string, paramRows: unknown[][]): Promise<void> {
      await conn.runBatch(sql, paramRows);
    },
    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      return withTransaction(conn, fn);
    },
    async reconcile() {
      return reconcile(conn, cfg, baseDir);
    },
    docs: {
      async columns() {
        return [...(await getColumns(conn))];
      },
      fieldStats: (columns, scopeWhere) => fieldStats(conn, columns, scopeWhere),
    },
    lexical: {
      async query() {
        return missing('lexical');
      },
    },
    vectors: {
      pending: () => pendingRows(conn),
      async writeVectors() {
        return missing('vectors');
      },
      async candidates() {
        return missing('vectors');
      },
      async similar() {
        return missing('vectors');
      },
      hasVector: (path) => hasVectorRow(conn, path),
    },
    async engineStatus() {
      // Read back rather than recomputed: this is what open() actually set (3x the largest
      // recorded reconcile, floored at 30s, capped at 10min), not a value re-derived here.
      // Turso's raw PRAGMA busy_timeout names its result column "busy_timeout" (spike-verified),
      // not "timeout" like real SQLite's own quirky column name for this one pragma.
      const row = (await (await db.prepare('PRAGMA busy_timeout')).get()) as { busy_timeout: number };
      return { busy_timeout: `${row.busy_timeout}ms (derived: 3x the largest reconcile this cache has recorded, floored at 30000ms)` };
    },
    raw: {
      async prepare(sql: string) {
        const stmt = await db.prepare(sql);
        stmt.safeIntegers(true); // int64 past 2^53 arrives as BigInt instead of losing precision
        return {
          columns: () => stmt.columns(),
          // sense sql streams through the client's own async generator.
          iterate: async function* (...params: unknown[]) {
            yield* stmt.iterate(...params);
          },
        };
      },
    },
    async close() {
      await db.close();
    },
  };
}
