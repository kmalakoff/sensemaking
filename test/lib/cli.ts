import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Spawn the built CLI the way agents invoke it.

export const cliPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'cli.js');
export const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function runCli(args: string[], opts: { cwd?: string } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', cwd: opts.cwd });
}

// A minimal two-note tree (one.md/two.md, tags alpha/beta) plus a --config-bound runCli, for
// every suite that drives the CLI against a throwaway sense.config.json rather than a cwd. Call
// once per test file; registers that file's own `after` cleanup for every tempDir() it hands out.
export function configTestTree() {
  const dirs: string[] = [];
  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }
  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  function makeTree(): string {
    const dir = tempDir('sense-sql-');
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
