// Shared table rendering: one cell-formatting rule per row kind and one markdown-table builder,
// used by compare.mjs, eval.mjs and report.ts so the same row prints identically everywhere.
import type { Row, RowReading } from './rows.ts';
import { rowValue } from './rows.ts';

export function mdTable(headers: readonly unknown[], rows: readonly (readonly unknown[])[]) {
  const lines = [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`];
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`);
  return lines.join('\n');
}

// A wall/inproc/total cell: a number in ms, a bold FAILED string, or an em dash for a
// version/store with no command for this row; pass unit explicitly for anything else.
export function msCell(value: unknown, unit = 'ms') {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return `**${value}**`;
  return `${value} ${unit}`;
}

// A tokens cell: value plus unit, or an em dash.
export function tokensCell(value: unknown) {
  return value === null || value === undefined ? '—' : `~${value} tokens`;
}

// A quality cell: four decimal places (nDCG/MRR/hit@10's usual precision), or an em dash.
export function qualityCell(value: unknown) {
  return value === null || value === undefined ? '—' : (value as { toFixed: (digits: number) => string }).toFixed(4);
}

export function cellFor(row: Pick<RowReading, 'kind'>, value: unknown) {
  if (row.kind === 'tokens') return tokensCell(value);
  if (row.kind === 'quality') return qualityCell(value);
  return msCell(value);
}

// Renders one row per catalog entry across N result objects, keyed by column label
// (compare.mjs's per-version columns, report.ts's prior/current pair).
export function renderRowsTable(catalogRows: readonly (Pick<RowReading, 'key' | 'label' | 'kind'> & { comparison_class?: Row['comparison_class'] })[], columns: readonly string[], resultsByColumn: Readonly<Record<string, unknown>>) {
  const headers = ['metric', 'comparison class', ...columns];
  const rows = catalogRows.map((row) => [row.label, row.comparison_class ?? 'unrecorded', ...columns.map((c) => cellFor(row, rowValue(resultsByColumn[c], row.key)))]);
  return mdTable(headers, rows);
}
