import type { Database } from '@tursodatabase/database';
import { STORE_DIMS } from '../../embed/types.ts';
import { getColumns, getMeta, setMeta } from '../shared.ts';
import { withTransaction } from '../transaction.ts';
import type { Capability, Connection, Statement, Store } from '../types.ts';
import { hasVectorRow, pendingRows } from '../vectors.ts';
import { cacheFilePath, checkpointWal, fileSize, reclaimSpace } from './connection.ts';
import { fieldStats } from './fieldStats.ts';
import { queryLexical } from './lexical.ts';
import { scanCandidates, scanSimilar, writeVectorBatch } from './vectors.ts';

// No 'snippets': fts_highlight returns the whole column, not a bounded window, so hits use
// the caller's JS excerpt.
export const CAPABILITIES: ReadonlySet<Capability> = new Set(['lexical', 'phrases', 'vectors']);

// close() reclaims once the cache file outgrows its compact size by this factor: the disk
// overhead a user should accept (PLAN 3.52), in postgres autovacuum scale-factor shape.
const BLOAT_FACTOR = 1.5;

// Shares one Connection instance (conn) with the builder's own reconcile call so transaction depth
// (see transaction.ts) is tracked against the same object everywhere.
export function createStore(db: Database, conn: Connection): Store {
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
    docs: {
      async columns() {
        return [...(await getColumns(conn))];
      },
      fieldStats: (columns, scopeWhere) => fieldStats(conn, columns, scopeWhere),
    },
    lexical: {
      query: (terms, opts) => queryLexical(conn, terms, opts),
    },
    // The column's fixed DDL width (STORE_DIMS) is what every scan binds against, not the
    // interface's per-call storeDims -- see vectors.ts's padded() for why a shorter vector is still correct against a wider column.
    vectors: {
      pending: () => pendingRows(conn),
      writeVectors: (rows) => writeVectorBatch(conn, STORE_DIMS, rows),
      candidates: (qv, _storeDims, fetch, allowed) => scanCandidates(conn, qv, STORE_DIMS, fetch, allowed),
      similar: (path, opts) => scanSimilar(conn, STORE_DIMS, path, opts),
      hasVector: (path) => hasVectorRow(conn, path),
    },
    async engineStatus() {
      // Read back rather than recomputed: this is what open() actually set (3x the largest
      // recorded reconcile, floored at 30s, capped at 10min). Turso's PRAGMA busy_timeout names its column "busy_timeout" (spike-verified), not "timeout" like real SQLite.
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
      // Checkpoint before measuring: the last reconcile's pages sit in the WAL, not the file yet.
      await checkpointWal(db);
      let reclaimPath: string | null = null;
      try {
        const path = await cacheFilePath(conn);
        const base = Number((await getMeta(conn, 'compact_size')) ?? '0');
        const size = path === null ? null : await fileSize(path);
        if (size !== null) {
          // No baseline yet (cold build or an upgraded cache): record it, never reclaim here, so a
          // cold build pays no VACUUM (PLAN 3.49 Track A) and an upgraded cache heals on a crossing.
          if (base === 0) {
            await setMeta(conn, 'compact_size', String(size));
            // The meta write landed past the checkpoint; leave no WAL for the next opener.
            await checkpointWal(db);
          } else if (size > BLOAT_FACTOR * base) {
            reclaimPath = path;
          }
        }
      } catch (err) {
        console.error(`sense: turso cache bloat check failed, the cache will keep its space until one succeeds: ${(err as Error).message}`);
      }
      await db.close();
      // After this store's connection is closed, never before: turso hands the file to one
      // connection at a time, and reclaimSpace opens its own to carry the `vacuum` flag (PLAN 3.54).
      if (reclaimPath !== null) await reclaimSpace(reclaimPath);
    },
  };
}
