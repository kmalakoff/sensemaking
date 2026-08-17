import type { ResolvedConfig } from '../config.ts';

// Handed to every command; each command parses its own argv via shared.ts's `parse`.
export interface Ctx {
  name: string;
  argv: string[]; // argv after the command word
  resolveConfig(configPath?: string): ResolvedConfig;
  usageError(message: string): never;
}

export type Command = (ctx: Ctx) => Promise<void> | void;
