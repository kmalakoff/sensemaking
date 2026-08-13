import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Spawn the built CLI the way agents invoke it.

export const cliPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'cli.js');
export const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function runCli(args: string[], opts: { cwd?: string } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', cwd: opts.cwd });
}
