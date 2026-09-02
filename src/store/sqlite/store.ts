import type { DatabaseSync } from 'node:sqlite';
import { getColumns } from '../shared.ts';
import { withTransaction } from '../transaction.ts';
import type { Capability, Connection, Statement, Store, VectorWriteRow } from '../types.ts';
import { hasVectorRow, pendingRows } from '../vectors.ts';
import { fieldStats } from './fieldStats.ts';
import { queryLexical } from './lexical.ts';
import { scanCandidates, scanSimilar, writeVectorBatch } from './vectors.ts';

export const CAPABILITIES: ReadonlySet<Capability> = new Set(['phrases', 'snippets', 'watch-concurrency', 'lexical', 'vectors', 'sql-functions']);

// Wraps the synchronous DatabaseSync connection in the async Store interface, sharing one
// Connection instance (conn) with the builder's own reconcile call so transaction depth is tracked against the same object everywhere.
export function createStore(db: DatabaseSync, conn: Connection): Store {
  return {
    name: 'sqlite',
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
      async fieldStats(columns, scopeWhere) {
        return fieldStats(conn, columns, scopeWhere);
      },
    },
    lexical: {
      async query(terms, opts) {
        return queryLexical(conn, terms, opts);
      },
    },
    vectors: {
      async pending() {
        return pendingRows(conn);
      },
      async writeVectors(rows: VectorWriteRow[]) {
        await writeVectorBatch(conn, rows);
      },
      async candidates(qv, storeDims, fetch, allowed) {
        return scanCandidates(conn, qv, storeDims, fetch, allowed);
      },
      async similar(path, opts) {
        return scanSimilar(conn, path, opts);
      },
      async hasVector(path) {
        return hasVectorRow(conn, path);
      },
    },
    async engineStatus() {
      // Read back rather than recomputed: this is what open() actually set (3x the largest
      // recorded reconcile, floored at 30s, capped at 10min), not a value re-derived here.
      const row = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
      return { busy_timeout: `${row.timeout}ms (derived: 3x the largest reconcile this cache has recorded, floored at 30000ms)` };
    },
    raw: {
      async prepare(sql: string) {
        const stmt = db.prepare(sql);
        stmt.setReadBigInts(true); // int64 past 2^53 arrives as BigInt instead of throwing at step time
        return {
          columns: () => stmt.columns(),
          // sense sql streams through an async iterator wrapping the sync iterate().
          iterate: async function* (...params: unknown[]) {
            yield* stmt.iterate(...(params as Parameters<typeof stmt.iterate>));
          },
        };
      },
    },
    async close() {
      db.close();
    },
  };
}
