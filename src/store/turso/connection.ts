import type { Database } from '@tursodatabase/database';
import { withTransaction } from '../transaction.ts';
import type { Connection, RunResult, Statement } from '../types.ts';

// The client's own Statement class isn't re-exported by name from '@tursodatabase/database',
// so its type is derived structurally from Database.prepare()'s return type instead.
type TursoStatement = Awaited<ReturnType<Database['prepare']>>;

// Turso's client is async end to end (no synchronous escape hatch like node:sqlite's), so this
// wraps it in the same Connection/Statement shape 1:1, no sync-over-async and no worker bridge.
class TursoStatementWrapper implements Statement {
  private stmt: TursoStatement;

  constructor(stmt: TursoStatement) {
    this.stmt = stmt;
  }

  async run(...params: unknown[]): Promise<RunResult> {
    return this.stmt.run(...params);
  }

  async get(...params: unknown[]): Promise<unknown> {
    return this.stmt.get(...params);
  }

  async all(...params: unknown[]): Promise<unknown[]> {
    return this.stmt.all(...params);
  }

  async *iterate(...params: unknown[]): AsyncIterable<unknown> {
    yield* this.stmt.iterate(...params);
  }

  columns(): Array<{ name: string }> {
    return this.stmt.columns();
  }

  setReadBigInts(enabled: boolean): void {
    this.stmt.safeIntegers(enabled);
  }
}

export function createConnection(db: Database): Connection {
  const conn: Connection = {
    async exec(sql: string): Promise<void> {
      await db.exec(sql);
    },
    async prepare(sql: string): Promise<Statement> {
      return new TursoStatementWrapper(await db.prepare(sql));
    },
    // db.batch() is the engine's own bulk idiom: one crossing, N rows, each its own statement,
    // no bind-variable ceiling to chunk around. A literal nested BEGIN hard-errors, so withTransaction's join-not-savepoint helper makes this safe inside reconcile's own transaction too.
    async runBatch(sql: string, paramRows: unknown[][]): Promise<void> {
      if (paramRows.length === 0) return;
      await withTransaction(conn, async () => {
        await db.batch(paramRows.map((args) => ({ sql, args })));
      });
    },
  };
  return conn;
}
