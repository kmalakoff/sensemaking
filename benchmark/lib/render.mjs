// Shared table rendering: one cell-formatting rule per row kind and one markdown-table builder,
// used by compare.mjs, eval.mjs and report.mjs so the same row prints identically everywhere.
import { rowValue } from './rows.mjs';

export function mdTable(headers, rows) {
  const lines = [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`];
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`);
  return lines.join('\n');
}

// A wall/inproc/total cell: a number in ms, a bold FAILED string, or an em dash for a
// version/store with no command for this row. Every catalog row of these kinds is measured in
// ms (bulk_change_ms and bulk_watch_ms included, despite 'total' also describing a
// possible future battery-elapsed-seconds row); pass unit explicitly for anything else.
export function msCell(value, unit = 'ms') {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return `**${value}**`;
  return `${value} ${unit}`;
}

// A tokens cell: value plus unit, or an em dash.
export function tokensCell(value) {
  return value === null || value === undefined ? '—' : `~${value} tokens`;
}

// A quality cell: four decimal places (nDCG/MRR/hit@10's usual precision), or an em dash.
export function qualityCell(value) {
  return value === null || value === undefined ? '—' : value.toFixed(4);
}

export function cellFor(row, value) {
  if (row.kind === 'tokens') return tokensCell(value);
  if (row.kind === 'quality') return qualityCell(value);
  return msCell(value);
}

// Renders one row per catalog entry across N result objects, keyed by column label
// (compare.mjs's per-version columns, report.mjs's prior/current pair).
export function renderRowsTable(catalogRows, columns, resultsByColumn) {
  const headers = ['metric', ...columns];
  const rows = catalogRows.map((row) => [row.label, ...columns.map((c) => cellFor(row, rowValue(resultsByColumn[c], row.key)))]);
  return mdTable(headers, rows);
}
