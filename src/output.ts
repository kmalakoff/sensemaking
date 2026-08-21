// rows -> table (default) | json

export type Row = Record<string, unknown>;

// Warned about on stderr (keeps --format json stdout machine-readable), never truncated.
const OVERSIZE_BYTES = 50_000;

// Flatten embedded newlines so they can't break table column alignment; JSON output is left alone.
function cell(value: unknown): string {
  return String(value ?? '').replace(/\s*\n\s*/g, ' ');
}

export function printRows(rows: Row[], format: 'table' | 'json'): void {
  const rendered = renderRows(rows, format);
  console.log(rendered);
  if (rendered.length > OVERSIZE_BYTES) {
    console.warn(`warning: result is ${Math.round(rendered.length / 1000)} KB across ${rows.length} row(s); consider a LIMIT, fewer columns, or snippet() instead of whole values`);
  }
}

// Tables are for reading, and a row wider than the terminal wraps unreadably: widest columns
// give up space first, down to a floor. --format json is never truncated.
const MIN_COLUMN = 12;
const TRUNCATED = '…';

function fitWidths(widths: number[], limit: number): number[] {
  const gaps = (widths.length - 1) * 2;
  const fitted = [...widths];
  for (;;) {
    const total = fitted.reduce((a, b) => a + b, 0) + gaps;
    if (total <= limit) return fitted;
    const widest = fitted.indexOf(Math.max(...fitted));
    if (fitted[widest] <= MIN_COLUMN) return fitted;
    fitted[widest] = Math.max(MIN_COLUMN, fitted[widest] - Math.max(1, total - limit));
  }
}

function renderRows(rows: Row[], format: 'table' | 'json', width = process.stdout.columns): string {
  if (format === 'json') return JSON.stringify(rows, null, 2);
  if (rows.length === 0) return '(0 rows)';

  const columns = Object.keys(rows[0]);
  const cells = rows.map((row) => columns.map((col) => cell(row[col])));
  const natural = columns.map((col, i) => Math.max(col.length, ...cells.map((row) => row[i].length)));
  const widths = width && width > MIN_COLUMN ? fitWidths(natural, width) : natural;

  const clip = (value: string, w: number) => (value.length <= w ? value.padEnd(w) : `${value.slice(0, w - 1)}${TRUNCATED}`);
  const formatRow = (values: string[]) =>
    values
      .map((value, i) => clip(value, widths[i]))
      .join('  ')
      .trimEnd();

  return [formatRow(columns), widths.map((w) => '-'.repeat(w)).join('  '), ...cells.map(formatRow)].join('\n');
}

// Text renderers for the top-level commands; cli.ts prints what these return.

// Names the config key that turns a feature back on. Only the three features-block toggles
// reach here; `embed` has its own status line.
export function featureOffHint(name: string): string {
  return `features.${name}`;
}

export function featuresLine(features: { on: string[]; off: string[] }): string {
  const off = features.off.length > 0 ? ` · off: ${features.off.map((name) => `${name} (${featureOffHint(name)})`).join(', ')}` : '';
  return `features: ${features.on.join(', ')}${off}`;
}

export function presetsLines(presets: Array<{ name: string; files: number; embedded: number }>): string[] {
  return ['presets:', ...presets.map((p) => `  ${p.name}: ${p.files} file(s), ${p.embedded} embedded`)];
}

export function renderMap(result: { docs: { count: number; bytes: number }; fields: Row[]; fieldsTotal: number; features: { on: string[]; off: string[] }; presets: Array<{ name: string; files: number; embedded: number }>; hubs: Row[]; recent: Row[] }): string {
  const parts = [`docs: ${result.docs.count} (${Math.round(result.docs.bytes / 1024)} KB)`, featuresLine(result.features), '', ...presetsLines(result.presets), '', renderRows(result.fields, 'table')];
  if (result.fieldsTotal > result.fields.length) parts.push(`(+${result.fieldsTotal - result.fields.length} more fields)`);
  if (result.hubs.length > 0) parts.push('\nhubs (by link rank):', renderRows(result.hubs, 'table'));
  else if (result.features.off.includes('rank')) parts.push(`\nhubs: off (${featureOffHint('rank')})`);
  parts.push('\nrecent:', renderRows(result.recent, 'table'));
  return parts.join('\n');
}

export function renderPeek(result: { path: string; tokens: number; frontmatter: Row; sections: Row[]; outbound: string[]; backlinks: string[]; unresolved: string[]; sectionsTotal: number; outboundTotal: number; backlinksTotal: number; unresolvedTotal: number; off: string[] }): string {
  const lines = [`${result.path}  (~${result.tokens} tokens)`];
  for (const [key, value] of Object.entries(result.frontmatter)) lines.push(`  ${key}: ${value}`);
  if (result.sections.length > 0) {
    lines.push('', 'sections:');
    for (const s of result.sections) lines.push(`  ${'#'.repeat(s.level as number)} ${s.heading}  [L${s.start_line}-${s.end_line}, ~${s.tokens}t]`);
    if (result.sectionsTotal > result.sections.length) lines.push(`  (+${result.sectionsTotal - result.sections.length} more sections -- sections table has all of them)`);
  } else if (result.off.includes('sections')) lines.push('', 'sections: off (features.sections)');
  if (result.off.includes('links')) {
    lines.push('', 'links: off (features.links)');
  } else {
    const linkLine = (label: string, shown: string[], total: number) => {
      if (total > 0) lines.push(`${label} (${total}): ${shown.join(', ')}${total > shown.length ? `, +${total - shown.length} more` : ''}`);
    };
    if (result.outboundTotal + result.unresolvedTotal + result.backlinksTotal > 0) lines.push('');
    linkLine('links out', result.outbound, result.outboundTotal);
    linkLine('unresolved', result.unresolved, result.unresolvedTotal);
    linkLine('backlinks', result.backlinks, result.backlinksTotal);
  }
  return lines.join('\n');
}
