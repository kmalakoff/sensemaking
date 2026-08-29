import type { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import type { Config } from '../../config/index.ts';
import { SenseError } from '../../errors.ts';
import { getColumns } from '../shared.ts';
import { withTransaction } from '../transaction.ts';
import type { Capability, Connection, Statement, Store, VectorWriteRow } from '../types.ts';
import { reconcile } from './reconcile.ts';

// This slice implements the portable surface only (frontmatter, links, sections, tags, rank,
// meta, raw sql passthrough) -- no fts, no vector storage/scan yet, so 'lexical' and 'vectors'
// are absent. openStore() gates the unambiguous case (an `embed` block requiring vectors)
// before this store even opens; lexical.query()/vectors.* below throw loudly as a second line
// of defense for any caller that reaches them anyway (principle 6: never silently return nothing).
export const CAPABILITIES: ReadonlySet<Capability> = new Set([]);

function capabilityMissing(name: 'lexical' | 'vectors'): SenseError {
  return new SenseError('STORE_CAPABILITY_MISSING', `store "duckdb" does not implement "${name}" in this build; switch "store" to "sqlite", or narrow the preset's signals to drop what needs it`);
}

// Shares one Connection instance (conn) with open()'s own reconcile call so transaction depth
// (see transaction.ts) is tracked against the same object everywhere.
export function createStore(instance: DuckDBInstance, duckdb: DuckDBConnection, conn: Connection, cfg: Config, baseDir: string): Store {
  return {
    name: 'duckdb',
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
    },
    lexical: {
      async query() {
        throw capabilityMissing('lexical');
      },
    },
    vectors: {
      async pending() {
        throw capabilityMissing('vectors');
      },
      async writeVectors(_rows: VectorWriteRow[]) {
        throw capabilityMissing('vectors');
      },
      async candidates() {
        throw capabilityMissing('vectors');
      },
      async similar() {
        throw capabilityMissing('vectors');
      },
      async hasVector() {
        throw capabilityMissing('vectors');
      },
    },
    raw: {
      async prepare(sql: string) {
        const prepared = await duckdb.prepare(sql);
        return {
          columns: () => {
            const out: Array<{ name: string }> = [];
            for (let i = 0; i < prepared.columnCount; i++) out.push({ name: prepared.columnName(i) });
            return out;
          },
          // Real incremental streaming: DuckDB reads its own result in row-group chunks, so
          // each readUntil only fetches what isn't already in hand.
          iterate: async function* (...params: unknown[]) {
            if (params.length > 0) prepared.bind(params as Parameters<typeof prepared.bind>[0]);
            const reader = await prepared.streamAndRead();
            let yielded = 0;
            do {
              await reader.readUntil(reader.currentRowCount + 2048);
              const rows = reader.getRowObjectsJS();
              for (; yielded < rows.length; yielded++) yield rows[yielded];
            } while (!reader.done);
          },
        };
      },
    },
    async close() {
      // The instance owns the WAL, so it closes last. Without the close DuckDB never checkpoints
      // and the next open reads a mismatched WAL.
      duckdb.disconnectSync();
      instance.closeSync();
    },
  };
}
