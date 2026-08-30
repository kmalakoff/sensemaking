import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { BEGIN_WRITE, withTransaction } from '../transaction.ts';
import type { Connection, RunResult, Statement } from '../types.ts';

// Wraps node:sqlite's synchronous DatabaseSync in the async Connection/Statement shape every store presents. Every method does its real
// work synchronously and returns an already-resolved promise, so reconcile's loop, the feature hooks, and runBatch never cross an async boundary internally.
class SqliteStatement implements Statement {
  private stmt: StatementSync;

  constructor(stmt: StatementSync) {
    this.stmt = stmt;
  }

  async run(...params: unknown[]): Promise<RunResult> {
    return this.stmt.run(...(params as Parameters<StatementSync['run']>));
  }

  async get(...params: unknown[]): Promise<unknown> {
    return this.stmt.get(...(params as Parameters<StatementSync['get']>));
  }

  async all(...params: unknown[]): Promise<unknown[]> {
    return this.stmt.all(...(params as Parameters<StatementSync['all']>));
  }

  async *iterate(...params: unknown[]): AsyncIterable<unknown> {
    yield* this.stmt.iterate(...(params as Parameters<StatementSync['iterate']>));
  }

  columns(): Array<{ name: string }> {
    return this.stmt.columns();
  }

  setReadBigInts(enabled: boolean): void {
    this.stmt.setReadBigInts(enabled);
  }
}

export function createConnection(db: DatabaseSync): Connection {
  const conn: Connection = {
    async exec(sql: string): Promise<void> {
      db.exec(sql);
    },
    async prepare(sql: string): Promise<Statement> {
      return new SqliteStatement(db.prepare(sql));
    },
    // Prepares once and loops synchronously, wrapped as one async call so features share one
    // Connection contract with DuckDB. Joins the caller's transaction when there is one (reconcile); otherwise opens its own, so a standalone batch stays atomic and commits once, not per row.
    async runBatch(sql: string, paramRows: unknown[][]): Promise<void> {
      if (paramRows.length === 0) return;
      await withTransaction(
        conn,
        async () => {
          const stmt = db.prepare(sql);
          for (const row of paramRows) stmt.run(...(row as Parameters<StatementSync['run']>));
        },
        BEGIN_WRITE
      );
    },
  };
  return conn;
}
