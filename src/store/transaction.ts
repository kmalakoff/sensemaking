// Store-agnostic joining transaction helper: node:sqlite and DuckDB both support only
// BEGIN/COMMIT/ROLLBACK, no SAVEPOINT -- nesting joins the outer transaction, sharing one semantics through exec(sql).
interface ExecConnection {
  exec(sql: string): Promise<void>;
}

interface TxState {
  depth: number;
  rollbackOnly: boolean;
}

// Keyed by connection, not a module singleton: two connections can coexist in one process
// (e.g. watch.ts alongside a CLI query) and must not share depth.
const states = new WeakMap<ExecConnection, TxState>();

function stateFor(conn: ExecConnection): TxState {
  let state = states.get(conn);
  if (!state) {
    state = { depth: 0, rollbackOnly: false };
    states.set(conn, state);
  }
  return state;
}

async function enter(conn: ExecConnection, state: TxState): Promise<void> {
  if (state.depth === 0) {
    await conn.exec('BEGIN');
    state.rollbackOnly = false;
  }
  state.depth++;
}

// Reaching depth 0 still rollback-only means an inner scope failed and an enclosing catch
// swallowed it; commit here would persist a partial write, so this rolls back and throws instead.
async function leaveOk(conn: ExecConnection, state: TxState): Promise<void> {
  state.depth--;
  if (state.depth > 0) return;
  if (state.rollbackOnly) {
    await conn.exec('ROLLBACK');
    throw new Error('transaction rolled back: a nested scope failed');
  }
  await conn.exec('COMMIT');
}

async function leaveErr(conn: ExecConnection, state: TxState): Promise<void> {
  state.rollbackOnly = true;
  state.depth--;
  if (state.depth === 0) await conn.exec('ROLLBACK');
}

// Depth-0 opens BEGIN; a nested call joins it and issues no SQL of its own. The outermost call
// owns COMMIT/ROLLBACK; every store and internal write loop goes through this one helper, so join semantics never differ by call site.
export async function withTransaction<T>(conn: ExecConnection, fn: () => Promise<T>): Promise<T> {
  const state = stateFor(conn);
  await enter(conn, state);
  let result: T;
  try {
    result = await fn();
  } catch (err) {
    await leaveErr(conn, state);
    throw err;
  }
  await leaveOk(conn, state);
  return result;
}
