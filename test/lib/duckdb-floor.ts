import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'cross-spawn-cb';
import semver from 'semver';
import { stagedCache } from 'staged-cache';
import { DUCKDB_FLOOR_VERSION } from '../constants.ts';
import { runCliAt } from './cli.ts';
import { packageRoot, scratchDir } from './tree.ts';

// A copy of the built CLI that resolves @duckdb/node-api at exactly DUCKDB_FLOOR_VERSION, so the floor of the declared range runs the real CLI.
// The install is named by its version, written under a staging name and renamed into place, and never changed afterwards, so it lives in .cache/shared.

const PACKAGE = '@duckdb/node-api';
const floorDir = join(packageRoot, '.cache', 'shared', `duckdb-node-api-${DUCKDB_FLOOR_VERSION}`);

// The `.` of the declared 1.x term, from the manifest the package publishes.
export function declaredFloor(): string {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { peerDependencies: Record<string, string> };
  const range = manifest.peerDependencies[PACKAGE];
  const term = new semver.Range(range).set.find((comparators) => semver.minVersion(new semver.Range(comparators.join(' ')))?.major === 1);
  if (!term) throw new Error(`${PACKAGE} peer range ${range} has no 1.x term`);
  return (semver.minVersion(new semver.Range(term.join(' '))) as semver.SemVer).version;
}

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) newest = Math.max(newest, statSync(join(entry.parentPath, entry.name)).mtimeMs);
  }
  return newest;
}

// npm test and test:engines do not build, and this suite copies dist/: fail at once rather than test an old build.
function assertBuilt(): void {
  const entries = ['cjs', 'esm'].map((mode) => join(packageRoot, 'dist', mode, 'cli.js'));
  const missing = entries.filter((entry) => !existsSync(entry));
  if (missing.length > 0) throw new Error(`dist/ is missing (${missing.join(', ')}); run \`npm run build\` before this suite`);
  const src = newestMtime(join(packageRoot, 'src'));
  const stale = entries.filter((entry) => statSync(entry).mtimeMs < src);
  if (stale.length > 0) throw new Error(`dist/ is older than src/ (${stale.join(', ')}); run \`npm run build\` before this suite`);
}

// npm skips an optional dependency that fails to download, so the platform binding is checked too: an entry that cannot load is never renamed into place.
function floorComplete(dir: string): boolean {
  const scope = join(dir, 'node_modules', '@duckdb');
  const manifest = join(scope, 'node-api', 'package.json');
  return existsSync(manifest) && (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }).version === DUCKDB_FLOOR_VERSION && existsSync(join(scope, 'node-bindings', 'package.json')) && existsSync(join(scope, `node-bindings-${process.platform}-${process.arch}`, 'package.json'));
}

async function installFloor(): Promise<string> {
  return stagedCache(floorDir, {
    verify: async (dir) => existsSync(dir) && floorComplete(dir),
    build: async (staging) => {
      mkdirSync(staging, { recursive: true });
      writeFileSync(join(staging, 'package.json'), '{"name":"duckdb-floor","private":true}'); // stop npm walking up
      // cross-spawn-cb rejects on a non-zero exit, so npm's stderr is read from the rejection.
      await spawn('npm', ['install', `${PACKAGE}@${DUCKDB_FLOOR_VERSION}`, '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', staging], { encoding: 'utf8' }).catch((err: Error & { stderr?: string }) => {
        throw new Error(`npm install ${PACKAGE}@${DUCKDB_FLOOR_VERSION} failed (${err.message}):\n${err.stderr ?? ''}`, { cause: err });
      });
    },
  });
}

let floorCli: Promise<string> | undefined;

// The copy's bin/cli.js. node_modules/@duckdb links to the cached install (a junction on Windows, which needs no privilege); semver and install-module-linked resolve from the checkout above .tmp/.
export function duckdbFloorCli(): Promise<string> {
  floorCli ??= (async () => {
    assertBuilt();
    const installed = await installFloor();
    const copy = scratchDir('duckdb-floor');
    for (const name of ['dist', 'bin', 'package.json', 'schema.json']) cpSync(join(packageRoot, name), join(copy, name), { recursive: true });
    mkdirSync(join(copy, 'node_modules'));
    symlinkSync(join(installed, 'node_modules', '@duckdb'), join(copy, 'node_modules', '@duckdb'), process.platform === 'win32' ? 'junction' : 'dir');
    return join(copy, 'bin', 'cli.js');
  })();
  return floorCli;
}

export async function runFloorCli(args: string[], opts: { cwd?: string } = {}) {
  return runCliAt(await duckdbFloorCli(), args, opts);
}
