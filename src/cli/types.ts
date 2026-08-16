import type { ResolvedConfig } from '../config.ts';

// Handed to every command; argv parsing stays in cli.ts.
export interface Ctx {
  name: string;
  rest: string[]; // positionals after the command word
  format: 'table' | 'json';
  values: { config?: string; where?: string; k?: string; preset?: string; include?: string[]; force: boolean; lexical: boolean };
  resolveConfig(): ResolvedConfig;
  usageError(message: string): never;
}

export type Command = (ctx: Ctx) => Promise<void> | void;
