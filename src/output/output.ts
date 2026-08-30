// rows -> table (default) | json | csv

export type Row = Record<string, unknown>;

// map/peek/status/path render structures rather than a row set, so csv has nothing to mean
// there; the commands that emit rows take RowFormat.
export type Format = 'table' | 'json';
export type RowFormat = Format | 'csv';

// Warned about on stderr (keeps --format json stdout machine-readable), never truncated.
const OVERSIZE_BYTES = 50_000;

// Flatten embedded newlines so they can't break table column alignment; JSON output keeps them as-is.
function cell(value: unknown): string {
  return String(value ?? '').replace(/\s*\n\s*/g, ' ');
}

// RFC 4180, deliberately not cell(): csv is the redirect-to-file format, so it keeps every
// character, newlines included; what it cannot carry (NULL vs empty, types) is what json is for.
function csvField(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /["\r\n,]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvLine(values: unknown[]): string {
  return values.map(csvField).join(',');
}

function warnOversize(bytes: number, rowCount: number): void {
  if (bytes <= OVERSIZE_BYTES) return;
  console.warn(`warning: result is ${Math.round(bytes / 1000)} KB across ${rowCount} row(s); consider a LIMIT, fewer columns, snippet() instead of whole values, or --format csv redirected to a file`);
}

// JSON.stringify throws on BigInt, and stores return int64 as BigInt (DuckDB does): a value
// that fits a safe integer stays a number, a larger one becomes its decimal string.
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const bigintSafe = (_key: string, value: unknown): unknown => (typeof value === 'bigint' ? (value >= -MAX_SAFE && value <= MAX_SAFE ? Number(value) : value.toString()) : value);

export function stringifyJson(value: unknown, indent?: number): string {
  return JSON.stringify(value, bigintSafe, indent);
}

export function printRows(rows: Row[], format: RowFormat, columns?: string[]): void {
  if (format === 'csv') {
    // Names from a row wherever there is one: the statement's column list keeps duplicates the
    // row collapsed. Nothing at all with no row and no columns -- a bare newline is an empty record.
    const names = rows.length > 0 ? Object.keys(rows[0]) : [...new Set(columns ?? [])];
    if (names.length === 0) return;
    const rendered = [csvLine(names), ...rows.map((row) => csvLine(names.map((name) => row[name])))].join('\n');
    console.log(rendered);
    // Bytes, not code units -- CJK is 3 bytes per character.
    warnOversize(Buffer.byteLength(rendered), rows.length);
    return;
  }
  const rendered = renderRows(rows, format);
  console.log(rendered);
  warnOversize(Buffer.byteLength(rendered), rows.length);
}

// Streaming counterpart for the one unbounded caller, `sense sql`: the result is never held as
// rows and again as a rendered string. Table buffers (column width depends on the last row); json/csv write row by row.
export async function printRowStream(rows: AsyncIterable<Row>, format: RowFormat, columns: string[]): Promise<void> {
  const iterator = rows[Symbol.asyncIterator]();
  // One step before any write. FTS5 parses a MATCH expression at step time rather than at
  // prepare time, so a bad search string throws here, with stdout still clean for the error.
  const first = await iterator.next();
  const rest: AsyncIterable<Row> = { [Symbol.asyncIterator]: () => iterator };

  if (format === 'table') {
    const collected: Row[] = first.done ? [] : [first.value];
    for await (const row of rest) collected.push(row);
    printRows(collected, format, columns);
    return;
  }

  let bytes = 0;
  let rowCount = 0;
  const write = (text: string): void => {
    // Bytes, not code units -- CJK is 3 bytes per character.
    bytes += Buffer.byteLength(text);
    process.stdout.write(text);
  };

  if (format === 'json') {
    // Byte-identical to JSON.stringify(rows, null, 2) + newline: each row re-indented one
    // level, comma-joined, inside the array brackets written here.
    const indent = (row: Row) =>
      stringifyJson(row, 2)
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n');
    if (first.done) {
      write('[]\n');
    } else {
      write('[\n');
      write(indent(first.value));
      rowCount = 1;
      for await (const row of rest) {
        write(',\n');
        write(indent(row));
        rowCount++;
      }
      write('\n]\n');
    }
  } else if (first.done) {
    const names = [...new Set(columns)];
    if (names.length > 0) write(`${csvLine(names)}\n`);
  } else {
    const names = Object.keys(first.value);
    write(`${csvLine(names)}\n`);
    write(`${csvLine(names.map((name) => first.value[name]))}\n`);
    rowCount = 1;
    for await (const row of rest) {
      write(`${csvLine(names.map((name) => row[name]))}\n`);
      rowCount++;
    }
  }
  warnOversize(bytes, rowCount);
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

function renderRows(rows: Row[], format: Format, width = process.stdout.columns): string {
  if (format === 'json') return stringifyJson(rows, 2);
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

// name, or name:weight when the weight is not the default 1.
function signalLabels(signals: Record<string, number>): string {
  return Object.entries(signals)
    .map(([name, weight]) => (weight === 1 ? name : `${name}:${weight}`))
    .join(', ');
}

export function presetsLines(presets: Array<{ name: string; files: number; embedded: number; signals: Record<string, number> }>): string[] {
  // "0 embedded" is ambiguous between a scope that declined vectors and one that has not built
  // them yet, so a preset without the vectors signal says what it uses instead.
  return ['presets:', ...presets.map((p) => `  ${p.name}: ${p.files} file(s), ${p.embedded} embedded${p.signals.vectors !== undefined ? '' : ` (signals: ${signalLabels(p.signals)})`}`)];
}

export function renderMap(result: {
  docs: { count: number; bytes: number };
  fields: Row[];
  fieldsTotal: number;
  features: { on: string[]; off: string[] };
  presets: Array<{ name: string; files: number; embedded: number; signals: Record<string, number> }>;
  hubs: Row[];
  recent: Row[];
  recentCaveat: string | null;
}): string {
  const parts = [`docs: ${result.docs.count} (${Math.round(result.docs.bytes / 1024)} KB)`, featuresLine(result.features), '', ...presetsLines(result.presets), '', renderRows(result.fields, 'table')];
  if (result.fieldsTotal > result.fields.length) parts.push(`(+${result.fieldsTotal - result.fields.length} more fields)`);
  if (result.hubs.length > 0) parts.push('\nhubs (by link rank):', renderRows(result.hubs, 'table'));
  else if (result.features.off.includes('rank')) parts.push(`\nhubs: off (${featureOffHint('rank')})`);
  parts.push('\nrecent:');
  if (result.recentCaveat) parts.push(result.recentCaveat);
  parts.push(renderRows(result.recent, 'table'));
  return parts.join('\n');
}

export function renderPeek(result: { path: string; tokens: number; frontmatter: Row; parseError?: string | null; sections: Row[]; outbound: string[]; backlinks: string[]; unresolved: string[]; sectionsTotal: number; outboundTotal: number; backlinksTotal: number; unresolvedTotal: number; off: string[] }): string {
  const lines = [`${result.path}  (~${result.tokens} tokens)`];
  // Otherwise a refused parse is indistinguishable from a note that has no frontmatter, which
  // is the confusion the whole quarantine design exists to remove.
  if (result.parseError) lines.push(`  frontmatter: did not parse, so none of it is indexed (${result.parseError})`);
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
