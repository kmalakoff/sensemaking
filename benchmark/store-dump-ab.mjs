#!/usr/bin/env node
// The write-path gate, run by the pipeline rather than by hand: capture the last release and the
// working tree, then diff. The old build is the npm install compare-versions already caches under
// .tmp/cache, so nothing is checked out and nothing is built twice.
// usage: node benchmark/store-dump-ab.mjs [--out <file>]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { safeRmSync } from 'fs-remove-compat';
import { cached } from './lib/cache.mjs';
import { writeOut } from './lib/out.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const {
  values: { out: outArg },
} = parseArgs({ options: { out: { type: 'string' } } });

// The baseline is package.json's version, the convention compare-versions already uses: the bump
// happens after a release, so that version names the last release until the moment you bump.
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

// Same cache key compare-versions writes, so a sitting that ran compare has already paid for this.
const installed = cached(`sensemaking-${version}`, (staging) => {
  writeFileSync(join(staging, 'package.json'), '{"name":"bench","private":true}');
  const r = spawnSync('npm', ['install', `sensemaking@${version}`, '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', staging], { cwd: staging, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`npm install sensemaking@${version} failed:\n${r.stderr}`);
});
const oldPkg = join(installed, 'node_modules', 'sensemaking');
if (!existsSync(join(oldPkg, 'dist', 'esm', 'index.js'))) throw new Error(`${oldPkg} carries no built dist to capture`);

const work = join(ROOT, '.tmp', 'store-dump-ab');
safeRmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

function capture(label, extra) {
  const dir = join(work, label);
  const r = spawnSync(process.execPath, [join(ROOT, 'benchmark', 'steps', 'store-dump.mjs'), 'capture', dir, ...extra], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`capture "${label}" failed with exit ${r.status}`);
  return dir;
}

console.log(`store-dump A/B: ${version} (installed from npm) against the working tree`);
const before = capture('before', ['--pkg-root', oldPkg]);
const after = capture('after', []);

const cmp = spawnSync(process.execPath, [join(ROOT, 'benchmark', 'steps', 'store-dump.mjs'), 'compare', before, after], { cwd: ROOT, encoding: 'utf8' });
process.stdout.write(cmp.stdout ?? '');
process.stderr.write(cmp.stderr ?? '');
if (outArg) writeOut(outArg, { baseline: version, ok: cmp.status === 0, output: cmp.stdout ?? '' });
process.exit(cmp.status ?? 1);
