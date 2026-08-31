import type { Database } from '@tursodatabase/database';
import { STORE_DIMS } from '../../embed/types.ts';
import { getColumns } from '../shared.ts';
import { withTransaction } from '../transaction.ts';
import type { Capability, Connection, Statement, Store } from '../types.ts';
import { hasVectorRow, pendingRows } from '../vectors.ts';
import { fieldStats } from './fieldStats.ts';
import { queryLexical } from './lexical.ts';
import { scanCandidates, scanSimilar, writeVectorBatch } from './vectors.ts';

// No 'snippets': fts_highlight returns the whole column, not a bounded window, so hits use
// the caller's JS excerpt. No 'watch-concurrency': single-process by default, as on duckdb.
export const CAPABILITIES: ReadonlySet<Capability> = new Set(['lexical', 'phrases', 'vectors']);

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
      await db.close();
    },
  };
}
