import type { Database } from '@tursodatabase/database';
import { BEGIN_WRITE, withTransaction } from '../transaction.ts';
import type { Connection, RunResult, Statement } from '../types.ts';

// The client's own Statement class isn't re-exported by name from '@tursodatabase/database',
// so its type is derived structurally from Database.prepare()'s return type instead.
type TursoStatement = Awaited<ReturnType<Database['prepare']>>;

// @tursodatabase/database/compat offers a synchronous escape hatch, but it measured only 4-12%
// faster than this promise client, so this wraps the async client in the same Connection/Statement shape 1:1.
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

// This client leaves the WAL behind for the next opener, where node:sqlite checkpoints on the last
// close, so a tree reconciled over and over grows one without bound. Best-effort: close must not throw.
export async function checkpointWal(db: Database): Promise<void> {
  try {
    await db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (err) {
    console.error(`sense: turso WAL checkpoint failed, the -wal file will keep growing until one succeeds: ${(err as Error).message}`);
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
    // Prepares once and awaits run() per row: db.batch() re-prepares each statement, which cost as
    // much as preparing per row. A literal nested BEGIN hard-errors, so withTransaction's join-not-savepoint helper makes this safe inside reconcile's own transaction too.
    async runBatch(sql: string, paramRows: unknown[][]): Promise<void> {
      if (paramRows.length === 0) return;
      await withTransaction(
        conn,
        async () => {
          const stmt = await db.prepare(sql);
          // Finalized here because nothing else will: open() hands back a connection the caller
          // can hold across many batches, and the db.batch() this replaced finalized its own.
          try {
            for (const row of paramRows) await stmt.run(...row);
          } finally {
            await stmt.close();
          }
        },
        BEGIN_WRITE
      );
    },
  };
  return conn;
}
