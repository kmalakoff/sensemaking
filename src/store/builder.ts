import type { Config } from '../config/index.ts';
import { ParsePool } from '../scan/pool.ts';
import { reconcile } from './reconcile.ts';
import type { Connection, ReconcileDialect } from './types.ts';

// Owns bringing a store's index current: the write half `Store` (types.ts) deliberately does not
// carry. A one-shot open calls build() once; a watcher calls it repeatedly on the same instance.
export interface Builder {
  build(): Promise<{ parsed: number; warnings: string[] }>;
  // Releases the parse worker pool, if this lifetime ever created one; never the connection.
  close(): Promise<void>;
  // Pools this lifetime has constructed, so reuse is observable rather than inferred.
  readonly poolsCreated: number;
}

// The pool is created at most once, lazily, on whichever build() call first needs it, and reused
// by every later build() on this instance.
export function createBuilder(conn: Connection, cfg: Config, baseDir: string, dialect: ReconcileDialect): Builder {
  const pool = new ParsePool();
  return {
    build: () => reconcile(conn, cfg, baseDir, dialect, pool),
    close: () => pool.close(),
    get poolsCreated() {
      return pool.poolsCreated;
    },
  };
}
