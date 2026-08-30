import type { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import type { Config } from '../../config/index.ts';
import { STORE_DIMS } from '../../embed/types.ts';
import { getColumns } from '../shared.ts';
// pending()/hasVector() are IS NULL/IS NOT NULL checks the portable Connection already
// answers identically regardless of the vector column's type, so this store reuses sqlite's
// (engine-neutral despite the module name) instead of duplicating them.
import { hasVectorRow, pendingRows } from '../sqlite/vectors.ts';
import { withTransaction } from '../transaction.ts';
import type { Capability, Connection, Statement, Store } from '../types.ts';
import { storeRowToJs } from './connection.ts';
import { createLexicalIndex } from './lexical.ts';
import { reconcile } from './reconcile.ts';
import { scanCandidates, scanSimilar, writeVectorBatch } from './vectors.ts';

// Portable surface, links/sections/tags/rank, raw sql passthrough, lexical (D1: fts BM25 +
// contains(), see lexical.ts), and vectors (D2: native FLOAT[N] + array_cosine_similarity, see
// vectors.ts) are implemented. 'snippets' is declined: no snippet()-equivalent exists, so every
// lexical hit relies on the caller's JS excerpt fallback (commands/search.ts) rather than a
// bounded engine-native one. 'phrases' means quoted-phrase matching only (types.ts):
// prefix/boolean/NEAR/column-filter FTS5 syntax is not claimed here -- lexical.ts rejects it
// rather than answer it differently.
export const CAPABILITIES: ReadonlySet<Capability> = new Set(['lexical', 'phrases', 'vectors']);

// Shares one Connection instance (conn) with open()'s own reconcile call so transaction depth
// (see transaction.ts) is tracked against the same object everywhere. The instance is the
// native database handle that owns the WAL: close() must close it, not just disconnect the
// connection, or DuckDB never checkpoints and the next open reads a mismatched WAL.
export function createStore(instance: DuckDBInstance, duckdb: DuckDBConnection, conn: Connection, cfg: Config, baseDir: string): Store {
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
    // The column's fixed DDL width (STORE_DIMS) is what every scan binds against, not the
    // interface's per-call storeDims -- see vectors.ts's padded() for why a shorter vector is
    // still correct against a wider column.
    vectors: {
      pending: () => pendingRows(conn),
      writeVectors: (rows) => writeVectorBatch(duckdb, conn, STORE_DIMS, rows),
      candidates: (qv, _storeDims, fetch, allowed) => scanCandidates(duckdb, qv, STORE_DIMS, fetch, allowed),
      similar: (path, opts) => scanSimilar(duckdb, conn, STORE_DIMS, path, opts),
      hasVector: (path) => hasVectorRow(conn, path),
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
              const rows = reader.getRowObjectsJS() as Array<Record<string, unknown>>;
              for (; yielded < rows.length; yielded++) yield storeRowToJs(rows[yielded]);
            } while (!reader.done);
          },
        };
      },
    },
    async close() {
      // Order matters: the connection must be gone before the instance closes the WAL.
      duckdb.disconnectSync();
      instance.closeSync();
    },
  };
}
