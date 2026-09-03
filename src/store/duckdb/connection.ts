import type { DuckDBConnection, DuckDBPreparedStatement, DuckDBValue } from '@duckdb/node-api';
import { quoteIdent } from '../shared.ts';
import { withTransaction } from '../transaction.ts';
import type { Connection, RunResult, Statement } from '../types.ts';
import { rewriteBatch } from './batch.ts';
import { duckdbApi } from './native.ts';

// getRowObjectsJS returns INT64 columns as BigInt regardless of magnitude, while sqlite's small
// ints are numbers and consumers assume number; in-range values convert here, out-of-range stays BigInt.
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
export function storeValueToJs(value: unknown): unknown {
  return typeof value === 'bigint' && value >= -MAX_SAFE && value <= MAX_SAFE ? Number(value) : value;
}
export function storeRowToJs(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[key] = storeValueToJs(value);
  return out;
}

// @duckdb/node-api only destroys a prepared statement when its connection closes, but a connection can stay open for a whole `sense watch` session.
// Statement has no dispose (callers reuse one instance across several calls), so this FinalizationRegistry reclaims it once nothing references the wrapper.
const preparedFinalizer = new FinalizationRegistry<DuckDBPreparedStatement>((prepared) => {
  prepared.destroySync();
});

// Wraps one already-prepared DuckDB statement: prepare() is the only async step, so run/get/all rebind and
// re-execute the same native statement, matching how callers like graph/traverse.ts's ring loop reuse one Statement across several calls.
class DuckdbStatement implements Statement {
  private prepared: DuckDBPreparedStatement;

  constructor(prepared: DuckDBPreparedStatement) {
    this.prepared = prepared;
    preparedFinalizer.register(this, prepared);
  }

  async run(...params: unknown[]): Promise<RunResult> {
    if (params.length > 0) this.prepared.bind(params as DuckDBValue[]);
    const result = await this.prepared.run();
    return { changes: result.rowsChanged, lastInsertRowid: 0 };
  }

  async get(...params: unknown[]): Promise<unknown> {
    const rows = await this.all(...params);
    return rows[0];
  }

  async all(...params: unknown[]): Promise<unknown[]> {
    if (params.length > 0) this.prepared.bind(params as DuckDBValue[]);
    const reader = await this.prepared.runAndReadAll();
    return (reader.getRowObjectsJS() as Array<Record<string, unknown>>).map(storeRowToJs);
  }

  async *iterate(...params: unknown[]): AsyncIterable<unknown> {
    // Never called on the portable Connection/Statement surface today (only Store.raw streams);
    // materializing keeps this a correct, if eager, AsyncIterable.
    yield* await this.all(...params);
  }

  columns(): Array<{ name: string }> {
    const out: Array<{ name: string }> = [];
    for (let i = 0; i < this.prepared.columnCount; i++) out.push({ name: this.prepared.columnName(i) });
    return out;
  }

  setReadBigInts(_enabled: boolean): void {
    // No-op: in-range ints are already numbers here (storeRowToJs converts what getRowObjectsJS
    // hands back as BigInt), so the node:sqlite throw-at-step-time problem does not exist.
  }
}

// Adds the native DuckDBConnection to the portable Connection, so duckdb's own dialect code
// (reconcile.ts's insertNew) can reach createAppender(); sqlite/turso have no such member.
export interface DuckdbConnection extends Connection {
  readonly duckdb: DuckDBConnection;
}

export function createConnection(duckdb: DuckDBConnection): DuckdbConnection {
  const conn: DuckdbConnection = {
    duckdb,
    async exec(sql: string): Promise<void> {
      await duckdb.run(sql);
    },
    async prepare(sql: string): Promise<Statement> {
      return new DuckdbStatement(await duckdb.prepare(sql));
    },
    // The appender writes columnar vectors with no per-parameter binding, which is the cost
    // runBatch pays: measured 7.2x on frontmatter at 6,566 rows. Alignment is against the table's
    // own physical column order, read fresh, so a column the caller does not write (a
    // feature-owned "_rank", say) takes appendDefault() rather than shifting every value one slot.
    async appendRows(table: string, columns: string[], rows: unknown[][]): Promise<void> {
      if (rows.length === 0) return;
      const { variantValue } = await duckdbApi();
      const infoStmt = await conn.prepare(`PRAGMA table_info(${quoteIdent(table)})`);
      const physical = (await infoStmt.all()) as Array<{ name: string; type: string }>;
      const rowIndexOf = new Map(columns.map((name, i) => [name, i]));

      await withTransaction(conn, async () => {
        const appender = await duckdb.createAppender(table);
        try {
          for (const row of rows) {
            for (const column of physical) {
              const idx = rowIndexOf.get(column.name);
              const value = idx === undefined ? undefined : row[idx];
              if (idx === undefined) appender.appendDefault();
              else if (value === null || value === undefined) appender.appendNull();
              // VARIANT is frontmatter's dynamic columns only; every other table is statically
              // typed, and appendValue is what preserves those types.
              else if (column.type === 'VARIANT') appender.appendVariant(variantValue(value as DuckDBValue));
              else appender.appendValue(value as DuckDBValue);
            }
            appender.endRow();
          }
          appender.flushSync();
        } finally {
          appender.closeSync();
        }
      });
    },
    // One crossing regardless of row count: rewriteBatch folds recognized shapes into a multi-row statement (batch.ts),
    // else falls back to a bind-and-run loop, one call either way. Joins the caller's transaction when there is one, else opens its own.
    async runBatch(sql: string, paramRows: unknown[][]): Promise<void> {
      if (paramRows.length === 0) return;
      await withTransaction(conn, async () => {
        const rewritten = rewriteBatch(sql, paramRows.length);
        if (rewritten) {
          const stmt = await duckdb.prepare(rewritten.sql);
          try {
            stmt.bind(paramRows.flat() as DuckDBValue[]);
            await stmt.run();
          } finally {
            stmt.destroySync();
          }
          return;
        }
        const stmt = await duckdb.prepare(sql);
        try {
          for (const row of paramRows) {
            stmt.bind(row as DuckDBValue[]);
            await stmt.run();
          }
        } finally {
          stmt.destroySync();
        }
      });
    },
  };
  return conn;
}
