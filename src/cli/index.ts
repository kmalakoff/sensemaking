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
  query: 'query "<sql>" [params...] [--format table|json] [--config path]',
  search: 'search "<terms>" [--preset name] [--include glob ...] [--where "<sql>"] [--k n] [--lexical] [--format table|json] [--config path]',
  map: 'map [--format table|json] [--config path]',
  peek: 'peek <path> [--format table|json] [--config path]',
} as const;

// Lazy registry: a command's imports load only when it runs, so a heavy dependency in one
// command never taxes the others (or --version/--help). These names are reserved: a named
// query in config can never shadow them.
export const COMMANDS: Record<string, () => Promise<{ default: Command }>> = {
  init: () => import('./init.ts'),
  watch: () => import('./watch.ts'),
  status: () => import('./status.ts'),
  check: () => import('./check.ts'),
  rebuild: () => import('./rebuild.ts'),
  query: () => import('./query.ts'),
  search: () => import('./search.ts'),
  map: () => import('./map.ts'),
  peek: () => import('./peek.ts'),
};

export type { Command, Ctx } from './types.ts';
