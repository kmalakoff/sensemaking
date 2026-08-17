// Commands never end the process themselves: they throw this, and cli.ts -- the one place
// that owns the exit -- drains stdio through exit-compat and returns. Neither alternative
// works here: a direct process.exit() races a pending write, and a bare return would let a
// command body run on after --help had already printed its usage.
export class ExitError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

export function usageError(message: string, usage?: string): never {
  console.error(message);
  if (usage !== undefined) console.error(usage);
  throw new ExitError(2);
}
