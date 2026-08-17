import getopts from 'getopts-compat';
import type { ResolvedConfig } from '../config.ts';
import type { OpenResult } from '../db.ts';
import { open } from '../db.ts';
import type { Row } from '../output.ts';
import { printRows } from '../output.ts';
import { searchError } from '../search-error.ts';
import { ExitError, usageError } from './exit.ts';
import type { Ctx } from './types.ts';

// Flag descriptors, spreadable so one flag name keeps one meaning across every command's
// table. parse() converts them to the getopts call the rest of the CLIs here make directly.
export interface Flag {
  type: 'string' | 'boolean';
  default?: string | boolean;
  multiple?: boolean;
  short?: string;
}
export type Flags = Record<string, Flag>;

export const FORMAT: Flags = { format: { type: 'string', default: 'table' } };
export const CONFIG: Flags = { config: { type: 'string' } };
export const SEARCH_FLAGS: Flags = {
  where: { type: 'string' },
  k: { type: 'string' },
  preset: { type: 'string' },
  include: { type: 'string', multiple: true },
  lexical: { type: 'boolean', default: false },
};

export type Values = Record<string, string | boolean | string[] | undefined>;

export function formatOf(values: Values): 'table' | 'json' {
  return values.format === 'json' ? 'json' : 'table';
}

// Per-command parse: strict (a foreign flag exits 2), and every table gets --help for free.
export function parse(argv: string[], usage: string, flags: Flags = {}): { values: Values; positionals: string[] } {
  const table: Flags = { ...flags, help: { type: 'boolean', default: false, short: 'h' } };
  const string: string[] = [];
  const boolean: string[] = [];
  const alias: Record<string, string> = {};
  const defaults: Record<string, string | boolean> = {};
  for (const [name, flag] of Object.entries(table)) {
    (flag.type === 'boolean' ? boolean : string).push(name);
    if (flag.default !== undefined) defaults[name] = flag.default;
    if (flag.short !== undefined) alias[name] = flag.short;
  }

  // getopts is lenient about undeclared flags -- they land in the result and are silently
  // ignored, which is the bug 0.9.2 fixed. Record the first and fail below; returning false
  // also keeps it out of the result. `--k -1` arrives here as unknown option "1", because
  // getopts reads a leading dash as a new option rather than as --k's value; the message is
  // blunter than the old one but it is still a usage error rather than a silent default.
  let unknown: string | undefined;
  const parsed = getopts(argv, {
    string,
    boolean,
    alias,
    default: defaults,
    unknown: (name: string): boolean => {
      if (unknown === undefined) unknown = name;
      return false;
    },
  });
  if (unknown !== undefined) usageError(`unknown option: ${unknown}`, usage);
  if (parsed.help) {
    console.log(usage);
    throw new ExitError(0);
  }

  // Two getopts shapes the callers must not see: an unset string flag reads as "" rather
  // than undefined, and a flag passed once reads as a string rather than a one-element
  // array. Both matter -- `?? saved.field` means "flag absent", and --include is a list.
  const values: Values = {};
  for (const [name, flag] of Object.entries(table)) {
    const raw = parsed[name];
    if (flag.type === 'boolean') values[name] = raw as boolean;
    else if (flag.multiple) values[name] = raw === '' ? undefined : Array.isArray(raw) ? (raw as string[]) : [raw as string];
    else values[name] = raw === '' ? undefined : (raw as string);
  }
  return { values, positionals: parsed._ };
}

// --k must be a positive integer: SQLite reads a bound LIMIT of -1 as "unlimited" and 0 as
// "nothing", and parseInt would silently truncate "5.9" -- all three are caller mistakes
// worth a usage error, matching the config-level SavedSearch validation.
export function parseK(k: string | undefined, usageErrorFn: (message: string) => never): number | undefined {
  if (k === undefined) return undefined;
  const parsed = Number(k);
  if (!Number.isInteger(parsed) || parsed <= 0) usageErrorFn(`--k expects a positive integer, got "${k}"`);
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

// An unbound `?` silently binds NULL, so mismatched param counts fail loudly instead.
export function runSql(cfg: ResolvedConfig, sql: string, params: string[], format: 'table' | 'json', label: string): void {
  const placeholderCount = (sql.match(/\?/g) ?? []).length;
  if (params.length !== placeholderCount) usageError(`${label} expects ${placeholderCount} parameter(s), got ${params.length}`);
  const { db, warnings } = open(cfg);
  printWarnings(warnings);
  let rows: Row[];
  try {
    rows = db.prepare(sql).all(...params) as Row[];
  } catch (err) {
    db.close();
    // A saved query or ad-hoc SQL can carry `content MATCH ?` too, so the same FTS5
    // punctuation trap applies -- the bound parameters are the search terms there. SQL
    // without MATCH gets its error verbatim; search advice on a plain typo would mislead.
    if (/\bMATCH\b/i.test(sql)) throw searchError(err as Error, params.join(' '));
    throw err;
  }
  printRows(rows, format);
  db.close();
}
