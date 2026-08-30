import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchDir } from './scratch.ts';

// Spawn the built CLI the way agents invoke it.

export const cliPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'cli.js');
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Windows won't delete a directory that is a live process's cwd, and scratch cleanup runs right after the test, so spawning into a scratch dir strands it; `--config` from the package root avoids that.
// `sense init`, the no-config-found suite, and upward config discovery need a real cwd instead; the config-existence check picks them out.
export function runCli(args: string[], opts: { cwd?: string } = {}) {
  const config = opts.cwd ? join(opts.cwd, 'sense.config.json') : null;
  if (config && existsSync(config)) return spawnSync(process.execPath, [cliPath, ...args, '--config', config], { encoding: 'utf8', cwd: packageRoot });
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', cwd: opts.cwd });
}

// A minimal two-note tree (one.md/two.md, tags alpha/beta) plus a --config-bound runCli, for
// every suite that drives the CLI against a throwaway sense.config.json rather than a cwd.
export function configTestTree() {
  function tempDir(prefix: string): string {
    return scratchDir(prefix.replace(/-+$/, ''));
  }
  function makeTree(): string {
    const dir = tempDir('sql');
    writeFileSync(join(dir, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['*.md'] } }, queries: {} }));
    writeFileSync(join(dir, 'one.md'), '---\ntitle: One\ntags: [alpha]\n---\nbody\n');
    writeFileSync(join(dir, 'two.md'), '---\ntitle: Two\ntags: [beta]\n---\nbody\n');
    return dir;
  }
  function runCliWithConfig(dir: string, args: string[]) {
    return runCli([...args, '--config', join(dir, 'sense.config.json')]);
  }
  return { tempDir, makeTree, runCli: runCliWithConfig };
}
