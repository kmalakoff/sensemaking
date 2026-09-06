// Rewrites a single-row parameterized INSERT into one multi-row statement. Engine-neutral string
// work, shared by duckdb (batch.ts's rewriteBatch) and turso (turso/connection.ts's runBatch).

const INSERT_RE = /^(INSERT\s+(?:OR\s+\w+\s+)?INTO\s+\S+\s*\([^)]*\)\s*VALUES\s*)\(([^()]*)\)(.*)$/is;

function placeholderCount(tuple: string): number {
  return (tuple.match(/\?/g) ?? []).length;
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
