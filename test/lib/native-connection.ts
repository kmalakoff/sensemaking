import { DatabaseSync } from 'node:sqlite';
import { type DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { connect as connectTurso } from '@tursodatabase/database';
import type { StoreName } from '../../src/config/types.ts';
import { createConnection as createDuckdbConnection } from '../../src/store/duckdb/connection.ts';
import { createConnection as createSqliteConnection } from '../../src/store/sqlite/connection.ts';
import { createConnection as createTursoConnection } from '../../src/store/turso/connection.ts';
import type { Connection } from '../../src/store/types.ts';

export interface OpenedNativeConnection {
  conn: Connection;
  close(): Promise<void>;
}

export async function openNativeConnection(store: StoreName, dbPath: string): Promise<OpenedNativeConnection> {
  if (store === 'sqlite') {
    const db = new DatabaseSync(dbPath);
    try {
      const conn = createSqliteConnection(db);
      let closed = false;
      return {
        conn,
        async close(): Promise<void> {
          if (closed) return;
          closed = true;
          db.close();
        },
      };
    } catch (err) {
      db.close();
      throw err;
    }
  }

  if (store === 'duckdb') {
    const instance = await DuckDBInstance.create(dbPath);
    let duckdb: DuckDBConnection | undefined;
    try {
      duckdb = await instance.connect();
      const native = duckdb;
      const conn = createDuckdbConnection(native);
      let closed = false;
      return {
        conn,
        async close(): Promise<void> {
          if (closed) return;
          closed = true;
          try {
            native.disconnectSync();
          } finally {
            instance.closeSync();
          }
        },
      };
    } catch (err) {
      try {
        duckdb?.disconnectSync();
      } finally {
        instance.closeSync();
      }
      throw err;
    }
  }

  if (store === 'turso') {
    const db = await connectTurso(dbPath, {});
    try {
      const conn = createTursoConnection(db);
      let closed = false;
      return {
        conn,
        async close(): Promise<void> {
          if (closed) return;
          closed = true;
          await db.close();
        },
      };
    } catch (err) {
      await db.close();
      throw err;
    }
  }
  throw new Error(`unsupported native store: ${store}`);
}

export async function withNativeConnection<T>(store: StoreName, dbPath: string, fn: (conn: Connection) => Promise<T>): Promise<T> {
  const opened = await openNativeConnection(store, dbPath);
  try {
    return await fn(opened.conn);
  } finally {
    await opened.close();
  }
}
