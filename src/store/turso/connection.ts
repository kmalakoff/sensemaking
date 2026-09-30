import { stat } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import type { Database } from '@tursodatabase/database';
import { rewriteInsert } from '../batch.ts';
import { setMeta } from '../shared.ts';
import { BEGIN_WRITE, withTransaction } from '../transaction.ts';
import type { Connection, RunResult, Statement } from '../types.ts';
import { CONNECT_OPTS, tursoApi } from './native.ts';
import { rewriteFunctions } from './sql-functions.ts';

// The client's own Statement class isn't re-exported by name from '@tursodatabase/database',
// so its type is derived structurally from Database.prepare()'s return type instead.
type TursoStatement = Awaited<ReturnType<Database['prepare']>>;

// Bound native multi-row compilation work; this is not Turso's variable-count limit.
export const INSERT_BIND_BUDGET = 8192;

async function closeStatement(stmt: TursoStatement, failed: boolean, failure: unknown): Promise<void> {
  try {
    await stmt.close();
  } catch (cleanup) {
    if (failed) throw new AggregateError([failure, cleanup], 'Turso statement execution and cleanup failed');
    throw cleanup;
  } finally {
    // Native result cleanup can wait on the event loop even after the statement is finalized.
    await setImmediate();
  }
}

// Native statements are finalized after execution. Reusing the portable statement prepares
// it again; column metadata remains available after execution without retaining native state.
class TursoStatementWrapper implements Statement {
  private stmt: TursoStatement | null;
  private readonly metadata: Array<{ name: string }>;
  private readBigInts = false;
  private readonly db: Database;
  private readonly sql: string;

  constructor(db: Database, sql: string, stmt: TursoStatement) {
    this.db = db;
    this.sql = sql;
    this.stmt = stmt;
    this.metadata = stmt.columns();
  }

  private async acquire(): Promise<TursoStatement> {
    const retained = this.stmt;
    this.stmt = null;
    const stmt = retained ?? (await this.db.prepare(this.sql));
    try {
      stmt.safeIntegers(this.readBigInts);
    } catch (error) {
      await closeStatement(stmt, true, error);
      throw error;
    }
    return stmt;
  }

  private async execute<T>(operation: (stmt: TursoStatement) => Promise<T>): Promise<T> {
    const stmt = await this.acquire();
    let failed = false;
    let failure: unknown;
    try {
      return await operation(stmt);
    } catch (error) {
      failed = true;
      failure = error;
      throw error;
    } finally {
      await closeStatement(stmt, failed, failure);
    }
  }

  async run(...params: unknown[]): Promise<RunResult> {
    return this.execute((stmt) => stmt.run(...params));
  }

  async get(...params: unknown[]): Promise<unknown> {
    return this.execute((stmt) => stmt.get(...params));
  }

  async all(...params: unknown[]): Promise<unknown[]> {
    return this.execute((stmt) => stmt.all(...params));
  }

  async *iterate(...params: unknown[]): AsyncIterable<unknown> {
    const stmt = await this.acquire();
    let failed = false;
    let failure: unknown;
    try {
      yield* stmt.iterate(...params);
    } catch (error) {
      failed = true;
      failure = error;
      throw error;
    } finally {
      await closeStatement(stmt, failed, failure);
    }
  }

  columns(): Array<{ name: string }> {
    return this.metadata;
  }

  setReadBigInts(enabled: boolean): void {
    this.readBigInts = enabled;
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

// The main cache file's path, or null when unresolvable. The store holds a Database and
// Connection, not a path (PLAN 3.52), so the path is read from the database itself.
export async function cacheFilePath(conn: Connection): Promise<string | null> {
  const rows = (await (await conn.prepare('PRAGMA database_list')).all()) as Array<{ name: string; file: string }>;
  return rows.find((r) => r.name === 'main')?.file || null;
}

export async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

// Reclaims turso#8170's FTS space amplification (PLAN 3.41), on a throwaway connection after the
// store's own has closed: `vacuum` doubles incremental reconcile cost merely by being enabled (3.54).
export async function reclaimSpace(path: string): Promise<void> {
  try {
    const turso = await tursoApi();
    const db = await turso.connect(path, { ...CONNECT_OPTS, experimental: [...CONNECT_OPTS.experimental, 'vacuum'] });
    try {
      await db.exec('VACUUM');
      const size = await fileSize(path);
      // Recorded here, not by the caller: this connection is the only one still open on the file.
      if (size !== null) await setMeta(createConnection(db), 'compact_size', String(size));
      await checkpointWal(db);
    } finally {
      await db.close();
    }
  } catch (err) {
    console.error(`sense: turso VACUUM failed, the cache will keep the space until one succeeds: ${(err as Error).message}`);
  }
}

export function createConnection(db: Database): Connection {
  const conn: Connection = {
    async exec(sql: string): Promise<void> {
      await db.exec(sql);
    },
    async prepare(sql: string): Promise<Statement> {
      const rewritten = rewriteFunctions(sql);
      const stmt = await db.prepare(rewritten);
      try {
        return new TursoStatementWrapper(db, rewritten, stmt);
      } catch (error) {
        await closeStatement(stmt, true, error);
        throw error;
      }
    },
    // Fold INSERTs into bounded multi-row statements in one transaction. UPDATE/DELETE keep
    // the per-row loop; each native statement owns its finalization and cleanup turn.
    async runBatch(sql: string, paramRows: unknown[][]): Promise<void> {
      if (paramRows.length === 0) return;
      await withTransaction(
        conn,
        async () => {
          const shape = rewriteInsert(sql, 1);
          const batchRows = shape ? Math.max(1, Math.floor(INSERT_BIND_BUDGET / shape.width)) : paramRows.length;
          for (let offset = 0; offset < paramRows.length; offset += batchRows) {
            const rows = shape ? paramRows.slice(offset, offset + batchRows) : paramRows;
            const rewritten = shape ? rewriteInsert(sql, rows.length) : null;
            const stmt = await db.prepare(rewritten?.sql ?? sql);
            let failed = false;
            let failure: unknown;
            try {
              if (rewritten) {
                // Pass one array: spreading a wide tuple can exceed the JS argument limit.
                await stmt.run(rows.flat());
              } else {
                for (const row of rows) await stmt.run(row);
              }
            } catch (error) {
              failed = true;
              failure = error;
              throw error;
            } finally {
              await closeStatement(stmt, failed, failure);
            }
          }
        },
        BEGIN_WRITE
      );
    },
  };
  return conn;
}
