import type { Command } from './types.ts';

// Each command's usage line, minus the leading "usage: <name> " -- shared by cli.ts's
// top-level usage() and the command's own parse() error/--help output, so there is one
// copy of each line, not two that can drift.
export const USAGE = {
  init: 'init',
  watch: 'watch [--force] [--config path]',
  status: 'status [--format table|json] [--config path]',
  check: 'check [--format table|json] [--config path]',
  rebuild: 'rebuild [--config path]',
  download: 'download [--config path]',
  sql: 'sql "<statement>" [params...] [--format table|json] [--config path]',
  search: 'search "<terms>" [--preset name] [--include glob ...] [--exclude glob ...] [--no-exclude] [--where "<sql>"] [--k n] [--format table|json] [--config path]',
  map: 'map [--format table|json] [--config path]',
  peek: 'peek <path> [--preset name] [--include glob ...] [--exclude glob ...] [--no-exclude] [--where "<sql>"] [--format table|json] [--config path]',
  path: 'path <a> <b> [--preset name] [--include glob ...] [--exclude glob ...] [--no-exclude] [--where "<sql>"] [--max-depth n] [--format table|json] [--config path]',
  related: 'related <note> [--preset name] [--include glob ...] [--exclude glob ...] [--no-exclude] [--where "<sql>"] [--k n] [--format table|json] [--config path]',
} as const;

// Lazy registry: a command's imports load only when it runs, so a heavy dependency in one
// command never taxes the others (or --version/--help). These names are reserved: a saved
// entry in config can never shadow them.
export const COMMANDS: Record<string, () => Promise<{ default: Command }>> = {
  init: () => import('./init.ts'),
  watch: () => import('./watch.ts'),
  status: () => import('./status.ts'),
  check: () => import('./check.ts'),
  rebuild: () => import('./rebuild.ts'),
  download: () => import('./download.ts'),
  sql: () => import('./sql.ts'),
  search: () => import('./search.ts'),
  map: () => import('./map.ts'),
  peek: () => import('./peek.ts'),
  path: () => import('./path.ts'),
  related: () => import('./related.ts'),
};

export type { Command, Ctx } from './types.ts';
