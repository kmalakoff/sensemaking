import type { DuckDBConnection } from '@duckdb/node-api';
import type { Config } from '../../config/index.ts';
import { SenseError } from '../../errors.ts';
import { getColumns } from '../shared.ts';
import { withTransaction } from '../transaction.ts';
import type { Capability, Connection, Statement, Store, VectorWriteRow } from '../types.ts';
import { createLexicalIndex } from './lexical.ts';
import { reconcile } from './reconcile.ts';

// Portable surface, links/sections/tags/rank, raw sql passthrough, and lexical (D1: fts BM25 +
// contains(), see lexical.ts) are implemented -- 'vectors' (D2) is not yet, so it still throws.
// 'snippets' is declined: no snippet()-equivalent exists, so every lexical hit relies on the
// caller's JS excerpt fallback (commands/search.ts) rather than a bounded engine-native one.
// 'phrases' means quoted-phrase matching only (types.ts): prefix/boolean/NEAR/column-filter
// FTS5 syntax is not claimed here -- lexical.ts rejects it rather than answer it differently.
export const CAPABILITIES: ReadonlySet<Capability> = new Set(['lexical', 'phrases']);

function capabilityMissing(name: 'vectors'): SenseError {
  return new SenseError('STORE_CAPABILITY_MISSING', `store "duckdb" does not implement "${name}" in this build; switch "store" to "sqlite", or narrow the preset's signals to drop what needs it`);
}

// Shares one Connection instance (conn) with open()'s own reconcile call so transaction depth
// (see transaction.ts) is tracked against the same object everywhere.
export function createStore(duckdb: DuckDBConnection, conn: Connection, cfg: Config, baseDir: string): Store {
  const lex = createLexicalIndex(conn);
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
      const result = await reconcile(conn, cfg, baseDir);
      // content may have changed; the fts index is rebuilt lazily, on the next lexical query
      // that needs it, not here (see lexical.ts's FtsIndexState).
      lex.markStale();
      return result;
    },
    docs: {
      async columns() {
        return [...(await getColumns(conn))];
      },
    },
    lexical: {
      query: lex.query,
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
      duckdb.disconnectSync();
    },
  };
}
