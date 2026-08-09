// rows -> table (default) | json

export type Row = Record<string, unknown>;

// Warned about on stderr (keeps --format json stdout machine-readable), never truncated.
const OVERSIZE_BYTES = 50_000;

// Flatten embedded newlines so they can't break table column alignment; JSON output is left alone.
function cell(value: unknown): string {
  return String(value ?? '').replace(/\s*\n\s*/g, ' ');
}

export function printRows(rows: Row[], format: 'table' | 'json'): void {
  const rendered = render(rows, format);
  console.log(rendered);
  if (rendered.length > OVERSIZE_BYTES) {
    console.warn(`warning: result is ${Math.round(rendered.length / 1000)} KB across ${rows.length} row(s); consider a LIMIT, fewer columns, or snippet() instead of whole values`);
  }
}

function render(rows: Row[], format: 'table' | 'json'): string {
  if (format === 'json') return JSON.stringify(rows, null, 2);
  if (rows.length === 0) return '(0 rows)';

  const columns = Object.keys(rows[0]);
  const cells = rows.map((row) => columns.map((col) => cell(row[col])));
  const widths = columns.map((col, i) => Math.max(col.length, ...cells.map((row) => row[i].length)));

  const formatRow = (values: string[]) => values.map((value, i) => value.padEnd(widths[i])).join('  ');

  return [formatRow(columns), widths.map((w) => '-'.repeat(w)).join('  '), ...cells.map(formatRow)].join('\n');
}
