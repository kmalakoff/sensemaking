// rows -> table (default) | json

export type Row = Record<string, unknown>;

export function printRows(rows: Row[], format: 'table' | 'json'): void {
  if (format === 'json') {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log('(0 rows)');
    return;
  }

  const columns = Object.keys(rows[0]);
  const widths = columns.map((col) => Math.max(col.length, ...rows.map((row) => String(row[col] ?? '').length)));

  const formatRow = (values: string[]) => values.map((value, i) => value.padEnd(widths[i])).join('  ');

  console.log(formatRow(columns));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) {
    console.log(formatRow(columns.map((col) => String(row[col] ?? ''))));
  }
}
