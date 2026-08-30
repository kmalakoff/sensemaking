const env = process.env.SENSE_TEST_ENV; // 'ci' | 'local-release' | undefined (permissive)

export type GateName = 'hf-network' | 'ollama' | 'lmstudio';

// Which environment owes each gate: unavailable there is a failure, naming the fix; elsewhere
// it is a free skip. A gate no environment owns yet is never strict, whatever SENSE_TEST_ENV is.
const OWNERS: Record<GateName, boolean> = {
  'hf-network': env === 'ci' || env === 'local-release',
  ollama: env === 'local-release',
  lmstudio: env === 'local-release',
};

export function gate(ctx: Mocha.Context, name: GateName, available: boolean, fix: string): void {
  if (available) return;
  if (OWNERS[name]) throw new Error(`gate "${name}" is owed by SENSE_TEST_ENV=${env} but unavailable: ${fix}`);
  ctx.skip();
}
