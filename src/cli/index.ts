import type { Command } from './types.ts';

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
