import type { ParseArgsOptionsConfig } from 'node:util';
import { parseArgs } from 'node:util';
import type { ResolvedConfig, SearchOverrides } from '../config/index.ts';
import { resolvePreset } from '../config/index.ts';
import { columnHint } from '../output/column-hint.ts';
import type { Row, RowFormat } from '../output/output.ts';
import { printRowStream } from '../output/output.ts';
import { searchError } from '../output/search-error.ts';
import type { OpenResult } from '../store/index.ts';
import { openStore } from '../store/index.ts';
import type { Store } from '../store/types.ts';
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

// The SCOPE fragment's parsed values as the overrides every scoped command passes down.
// One place to read them: a new scope field is added to the fragment and here, not per-command.
export function scopeOf(values: Values): SearchOverrides {
  return {
    preset: values.preset as string | undefined,
    include: values.include as string[] | undefined,
    exclude: values.exclude as string[] | undefined,
    where: values.where as string | undefined,
    noExclude: values['no-exclude'] === true,
  };
}

// parseArgs is strict about flag names; this applies the same strictness to the value.
// An unrecognised --format is a usage error, not a silent fallback to `table`.
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

// --k must be a positive integer: SQLite reads a bound LIMIT of -1 as "unlimited" and 0 as "nothing", and parseInt would silently truncate "5.9".
// All three are caller mistakes worth a usage error, matching the config-level SavedSearch validation.
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

export async function withDb(ctx: Ctx, configPath: string | undefined, fn: (store: OpenResult['store'], cfg: ResolvedConfig) => void | Promise<void>): Promise<void> {
  const cfg = ctx.resolveConfig(configPath);
  const { store, warnings } = await openStore(cfg);
  printWarnings(warnings);
  try {
    await fn(store, cfg);
  } finally {
    await store.close();
  }
}

// `--preset` on SQL binds a temp `scope` table rather than transparently filtering: temp views shadowing the base tables can't cover `content`, since FTS5 MATCH treats the table name as a hidden column.
// A flag that silently scoped three tables of four would look scoped and not be.
async function bindScope(store: Store, cfg: ResolvedConfig, preset: string): Promise<void> {
  const { name } = resolvePreset(cfg, preset); // unknown names throw, listing what is declared
  await store.exec('DROP TABLE IF EXISTS temp.scope');
  await store.exec('CREATE TEMP TABLE scope ("path" TEXT PRIMARY KEY)');
  const insert = await store.prepare('INSERT INTO temp.scope ("path") SELECT "path" FROM preset_files WHERE preset = ?');
  await insert.run(name);
}

// An unbound `?` silently binds NULL, so mismatched param counts fail loudly instead.
export async function runSql(cfg: ResolvedConfig, sql: string, params: string[], format: RowFormat, label: string, preset?: string): Promise<void> {
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
  const { store, warnings } = await openStore(cfg);
  printWarnings(warnings);
  if (preset !== undefined) await bindScope(store, cfg, preset);
  // Streamed, not collected: `sql`'s result size is the caller's business, not ours. columns() reads the statement's own metadata, so a 0-row csv gets a header too.
  // A mid-stream SQLite error (e.g. SQLITE_BUSY outlasting busy_timeout) may leave partial output; the nonzero exit code is the failure signal, not a completeness guarantee.
  try {
    const statement = await store.raw.prepare(sql);
    const columns = statement.columns().map((c) => c.name);
    await printRowStream(statement.iterate(...params) as AsyncIterable<Row>, format, columns);
  } catch (err) {
    const hinted = columnHint(await store.docs.columns(), err as Error); // columns read while the store is still open
    await store.close();
    // A saved query or ad-hoc SQL can carry `content MATCH ?` too, so the same FTS5 punctuation trap applies to its bound parameters.
    // SQL without MATCH gets its error verbatim; search advice on a plain typo would mislead.
    if (/\bMATCH\b/i.test(sql)) throw searchError(hinted, params.join(' '));
    throw hinted;
  }
  await store.close();
}
