import type { DuckDBConnection, DuckDBPreparedStatement, DuckDBValue } from '@duckdb/node-api';
import { withTransaction } from '../transaction.ts';
import type { Connection, RunResult, Statement } from '../types.ts';
import { rewriteBatch } from './batch.ts';

// getRowObjectsJS returns INT64 columns as BigInt regardless of magnitude, while sqlite's
// small ints are numbers and consumers assume number. Beyond the safe range stays BigInt (the
// setReadBigInts contract); stringifyJson keeps JSON output safe.
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
export function storeValueToJs(value: unknown): unknown {
  return typeof value === 'bigint' && value >= -MAX_SAFE && value <= MAX_SAFE ? Number(value) : value;
}
export function storeRowToJs(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[key] = storeValueToJs(value);
  return out;
}

// @duckdb/node-api tracks every prepared statement itself and destroys any survivor when the
// connection closes, but sense's stores stay open for a whole `sense watch` session -- nothing
// destroys one before then. The portable Statement interface has no dispose (sqlite's node:sqlite
// statements need none, and callers like graph/traverse.ts's ring loop reuse one Statement across
// several run/get/all calls, so a per-call destroy would be wrong), so cleanup happens here,
// locally, once nothing references the wrapper any more. destroySync() is safe to call more than
// once -- runBatch below and vectors.ts already call it explicitly while the same connection-close
// sweep can also reach a statement that outlives its wrapper, with no reported issue.
const preparedFinalizer = new FinalizationRegistry<DuckDBPreparedStatement>((prepared) => {
  prepared.destroySync();
});

// Wraps one already-prepared DuckDB statement: prepare() is the only async step (Store.prepare
// already crosses the async boundary once), so columns() reads back synchronously from it and
// run/get/all rebind and re-execute the same native statement, matching how a caller (e.g.
// graph/traverse.ts's ring loop) reuses one Statement across several calls.
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

export function createConnection(duckdb: DuckDBConnection): Connection {
  const conn: Connection = {
    async exec(sql: string): Promise<void> {
      await duckdb.run(sql);
    },
    async prepare(sql: string): Promise<Statement> {
      return new DuckdbStatement(await duckdb.prepare(sql));
    },
    // One crossing regardless of row count: rewriteBatch turns the caller's single-row SQL into
    // one multi-row statement when it recognizes the shape (see batch.ts); anything else falls
    // back to a bind-and-run loop over one prepared statement, still a single call to the caller.
    // Joins the caller's transaction when there is one (reconcile); otherwise opens its own, so
    // a standalone batch stays atomic.
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
