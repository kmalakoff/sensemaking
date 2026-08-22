import type { ParseArgsOptionsConfig } from 'node:util';
import { parseArgs } from 'node:util';
import type { ResolvedConfig, SearchOverrides } from '../config.ts';
import { resolvePreset } from '../config.ts';
import type { OpenResult } from '../db.ts';
import { open } from '../db.ts';
import type { Row, RowFormat } from '../output.ts';
import { printRowStream } from '../output.ts';
import { searchError } from '../search-error.ts';
import type { Ctx } from './types.ts';

// Spreadable option fragments -- one flag name keeps one meaning across every command's table.
export const FORMAT: ParseArgsOptionsConfig = { format: { type: 'string', default: 'table' } };
export const CONFIG: ParseArgsOptionsConfig = { config: { type: 'string' } };
// The scope vocabulary every scoped command shares: named preset, ad hoc include/exclude
// globs, a where SQL condition. search adds k on top.
export const SCOPE: ParseArgsOptionsConfig = {
  where: { type: 'string' },
  preset: { type: 'string' },
  include: { type: 'string', multiple: true },
  exclude: { type: 'string', multiple: true },
  // Widening, which no other flag can express: --include and --exclude each override their
  // own side of the preset, so neither can drop an exclusion the preset declares.
  'no-exclude': { type: 'boolean', default: false },
};
export const SEARCH_FLAGS: ParseArgsOptionsConfig = { ...SCOPE, k: { type: 'string' } };

type Values = Record<string, string | boolean | string[] | undefined>;

// The SCOPE fragment's parsed values as the overrides every scoped command passes down. One
// place to read them, so a new scope field is added to the fragment and here, not in each
// command's call.
export function scopeOf(values: Values): SearchOverrides {
  return {
    preset: values.preset as string | undefined,
    include: values.include as string[] | undefined,
    exclude: values.exclude as string[] | undefined,
    where: values.where as string | undefined,
    noExclude: values['no-exclude'] === true,
  };
}

// An unrecognised value used to fall through to `table`, so a typo looked like it worked.
// parseArgs is strict about flag names; this is the same strictness for the value.
function pickFormat<T extends string>(values: Values, allowed: readonly T[]): T {
  const format = String(values.format);
  if ((allowed as readonly string[]).includes(format)) return format as T;
  console.error(`unknown --format "${format}"; expected ${allowed.join(', ')}`);
  process.exit(2);
}

export function formatOf(values: Values): 'table' | 'json' {
  return pickFormat(values, ['table', 'json'] as const);
}

// csv is a row set rendered as rows; map, peek, status, and path render structures instead,
// and take formatOf.
export function rowFormatOf(values: Values): RowFormat {
  return pickFormat(values, ['table', 'json', 'csv'] as const);
}

// Per-command parseArgs: strict (a foreign flag exits 2), and every table gets --help for free.
export function parse(argv: string[], usage: string, options: ParseArgsOptionsConfig): { values: Values; positionals: string[] } {
  let values: Values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: { ...options, help: { type: 'boolean', default: false, short: 'h' } },
      strict: true,
      allowPositionals: true,
    }));
  } catch (err) {
    console.error((err as Error).message);
    console.error(usage);
    process.exit(2);
  }
  if (values.help) {
    console.log(usage);
    process.exit(0);
  }
  return { values, positionals };
}

// --k must be a positive integer: SQLite reads a bound LIMIT of -1 as "unlimited" and 0 as
// "nothing", and parseInt would silently truncate "5.9" -- all three are caller mistakes
// worth a usage error, matching the config-level SavedSearch validation.
export function parseK(k: string | undefined, usageError: (message: string) => never): number | undefined {
  if (k === undefined) return undefined;
  const parsed = Number(k);
  if (!Number.isInteger(parsed) || parsed <= 0) usageError(`--k expects a positive integer, got "${k}"`);
  return parsed;
}

// Shared open-query-close envelope for commands that touch the tree.

export function printWarnings(warnings: string[]): void {
  for (const w of warnings) console.warn(w);
}

export async function withDb(ctx: Ctx, configPath: string | undefined, fn: (db: OpenResult['db'], cfg: ResolvedConfig) => void | Promise<void>): Promise<void> {
  const cfg = ctx.resolveConfig(configPath);
  const { db, warnings } = open(cfg);
  printWarnings(warnings);
  try {
    await fn(db, cfg);
  } finally {
    db.close();
  }
}

// `--preset` on SQL binds the scope rather than applying it: the statement joins `scope`
// itself. Filtering behind the query's back is not available -- the obvious version, temp views
// shadowing the base tables, cannot cover `content`, because FTS5 `MATCH` uses the table name
// as a hidden column and a view has none. A flag that silently scoped three tables of four
// would look scoped and not be. See plans/vault-field-report-fixes.md item F.
function bindScope(db: OpenResult['db'], cfg: ResolvedConfig, preset: string): void {
  const { name } = resolvePreset(cfg, preset); // unknown names throw, listing what is declared
  db.exec('DROP TABLE IF EXISTS temp.scope');
  db.exec('CREATE TEMP TABLE scope ("path" TEXT PRIMARY KEY)');
  db.prepare('INSERT INTO temp.scope ("path") SELECT "path" FROM preset_files WHERE preset = ?').run(name);
}

// An unbound `?` silently binds NULL, so mismatched param counts fail loudly instead.
export function runSql(cfg: ResolvedConfig, sql: string, params: string[], format: RowFormat, label: string, preset?: string): void {
  const placeholderCount = (sql.match(/\?/g) ?? []).length;
  if (params.length !== placeholderCount) {
    console.error(`${label} expects ${placeholderCount} parameter(s), got ${params.length}`);
    process.exit(2);
  }
  // Naming a preset and never joining it would return the whole index while reading as scoped,
  // which is the one hazard of binding rather than applying. Refuse instead.
  if (preset !== undefined && !/\bscope\b/i.test(sql)) {
    console.error(`--preset binds a temporary "scope" table of the preset's paths, and ${label} never joins it, so the preset would have no effect`);
    console.error(`add: JOIN scope ON scope."path" = <table>."path"`);
    process.exit(2);
  }
  const { db, warnings } = open(cfg);
  printWarnings(warnings);
  if (preset !== undefined) bindScope(db, cfg, preset);
  // Streamed rather than collected: `sql` is the one caller whose result size is the
  // statement's business, not this package's, so the rows are never held here in bulk.
  // columns() reads the statement's own metadata, so a 0-row csv still has its header.
  // A mid-stream SQLite error (e.g. SQLITE_BUSY outlasting busy_timeout) can still leave
  // partial output; the nonzero exit code is the caller's signal, output completeness is not
  // guaranteed on failure.
  try {
    const statement = db.prepare(sql);
    statement.setReadBigInts(true); // int64 past 2^53 arrives as BigInt instead of throwing at step time
    const columns = statement.columns().map((c) => c.name);
    printRowStream(statement.iterate(...params) as Iterable<Row>, format, columns);
  } catch (err) {
    db.close();
    // A saved query or ad-hoc SQL can carry `content MATCH ?` too, so the same FTS5
    // punctuation trap applies -- the bound parameters are the search terms there. SQL
    // without MATCH gets its error verbatim; search advice on a plain typo would mislead.
    if (/\bMATCH\b/i.test(sql)) throw searchError(err as Error, params.join(' '));
    throw err;
  }
  db.close();
}
