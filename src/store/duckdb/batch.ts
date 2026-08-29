// Rewrites a single-row parameterized statement -- the shape every write loop in this codebase
// prepares once and calls with N different param sets -- into one statement DuckDB executes over
// all N rows in a single round trip. A columnar engine's cost is row-at-a-time writes themselves,
// not just the async crossing to reach them, so this recognizes the three statement shapes the
// store issues (INSERT ... VALUES (...), UPDATE ... SET ... WHERE ..., DELETE ... WHERE ...) and
// rewrites each into a multi-row form, verified against a live DuckDB connection at
// implementation time (principle 8). Unrecognized SQL returns null; connection.ts's runBatch
// falls back to a prepare-once, bind-and-run loop -- still one call from outside the store.
//
// This only ever runs against sense's own SQL literals (reconcile, the feature hooks), never
// arbitrary user SQL (`sense sql` is a separate, unrewritten passthrough), so the shapes below
// are exactly what those call sites emit, not a general parser.

const INSERT_RE = /^(INSERT\s+(?:OR\s+\w+\s+)?INTO\s+\S+\s*\([^)]*\)\s*VALUES\s*)\(([^()]*)\)(.*)$/is;
const UPDATE_RE = /^UPDATE\s+(\S+)\s+SET\s+(.+?)\s+WHERE\s+(.+)$/is;
const DELETE_RE = /^DELETE\s+FROM\s+(\S+)\s+WHERE\s+(.+)$/is;

function placeholderCount(tuple: string): number {
  return (tuple.match(/\?/g) ?? []).length;
}

// "a = ?, b = ?" or "a = ? AND b = ?" -> ["a", "b"]. Only ever called on clauses already
// shaped that way by the regexes above; a clause that doesn't fit yields a column list whose
// length won't match the caller's row width, which rewriteUpdate/rewriteDelete then reject.
function equalityColumns(clause: string, sep: RegExp): string[] | null {
  const parts = clause.split(sep).map((p) => p.trim());
  const cols: string[] = [];
  for (const part of parts) {
    const m = /^(.+?)=\s*\?$/.exec(part);
    if (!m) return null;
    cols.push(m[1].trim());
  }
  return cols;
}

function tuples(rowCount: number, width: number): string {
  const row = `(${Array.from({ length: width }, () => '?').join(', ')})`;
  return Array.from({ length: rowCount }, () => row).join(', ');
}

export function rewriteInsert(sql: string, rowCount: number): { sql: string; width: number } | null {
  const m = INSERT_RE.exec(sql.trim());
  if (!m) return null;
  const [, head, tuple, tail] = m;
  const width = placeholderCount(tuple);
  if (width === 0) return null;
  const rows = Array.from({ length: rowCount }, () => `(${tuple})`).join(', ');
  return { sql: `${head}${rows}${tail}`, width };
}

export function rewriteUpdate(sql: string, rowCount: number): { sql: string; width: number } | null {
  const m = UPDATE_RE.exec(sql.trim());
  if (!m) return null;
  const [, table, setClause, whereClause] = m;
  const setCols = equalityColumns(setClause, /,/);
  const whereCols = equalityColumns(whereClause, /\bAND\b/i);
  if (!setCols || !whereCols) return null;
  const dataCols = [...setCols, ...whereCols];
  const setAssign = setCols.map((c) => `${c} = data.${c}`).join(', ');
  const joinCond = whereCols.map((c) => `${table}.${c} = data.${c}`).join(' AND ');
  return { sql: `UPDATE ${table} SET ${setAssign} FROM (VALUES ${tuples(rowCount, dataCols.length)}) AS data(${dataCols.join(', ')}) WHERE ${joinCond}`, width: dataCols.length };
}

export function rewriteDelete(sql: string, rowCount: number): { sql: string; width: number } | null {
  const m = DELETE_RE.exec(sql.trim());
  if (!m) return null;
  const [, table, whereClause] = m;
  const cols = equalityColumns(whereClause, /\bAND\b/i);
  if (!cols) return null;
  if (cols.length === 1) {
    return { sql: `DELETE FROM ${table} WHERE ${cols[0]} IN (${Array.from({ length: rowCount }, () => '?').join(', ')})`, width: 1 };
  }
  return { sql: `DELETE FROM ${table} WHERE (${cols.join(', ')}) IN (VALUES ${tuples(rowCount, cols.length)})`, width: cols.length };
}

// Tries each shape in turn; null means the caller should fall back to a per-row loop.
export function rewriteBatch(sql: string, rowCount: number): { sql: string; width: number } | null {
  return rewriteInsert(sql, rowCount) ?? rewriteUpdate(sql, rowCount) ?? rewriteDelete(sql, rowCount);
}
