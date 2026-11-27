// Reaches the network once: the legacy case installs released sensemaking 0.1.0 into .cache/shared.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'assert';
import { SUPPORTED_CONFIG_VERSION } from 'sensemaking';
import { cachedRelease } from '../../benchmark/lib/cache.ts';
import { probeConfigVersion, probeHelp } from '../../benchmark/lib/measure.ts';
import { packageRoot, scratchDir } from '../lib/tree.ts';

// A package root holding only the files a probe reads: bin/cli.js and dist/esm/index.js.
function packageWith(files: { cli?: string; entry?: string }) {
  const root = scratchDir('probe-package');
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  if (files.cli !== undefined) {
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(join(root, 'bin', 'cli.js'), files.cli);
  }
  if (files.entry !== undefined) {
    mkdirSync(join(root, 'dist', 'esm'), { recursive: true });
    writeFileSync(join(root, 'dist', 'esm', 'index.js'), files.entry);
  }
  return root;
}
const cliOf = (root: string) => join(root, 'bin', 'cli.js');

describe('benchmark structural probes: a failed probe stops the run with its diagnostic', () => {
  it('help probe: a nonzero exit names the exit code and both streams', () => {
    const root = packageWith({ cli: 'process.stdout.write("partial"); console.error("help broke"); process.exit(3);' });
    assert.throws(
      () => probeHelp(cliOf(root)),
      (err: Error) => err.message.startsWith('CLI help probe failed: exit 3, signal none, spawn error none;') && err.message.includes('stdout "partial"') && err.message.includes('stderr "help broke\\n"')
    );
  });

  it('help probe: a missing CLI entry (a build in progress) is a failure, not a legacy CLI', () => {
    const root = packageWith({});
    assert.throws(
      () => probeHelp(cliOf(root)),
      (err: Error) => err.message.startsWith('CLI help probe failed: exit 1,') && err.message.includes('Cannot find module')
    );
  });

  it('help probe: a signalled child names the signal', () => {
    const root = packageWith({ cli: 'process.kill(process.pid, "SIGKILL");' });
    assert.throws(
      () => probeHelp(cliOf(root)),
      (err: Error) => err.message.startsWith('CLI help probe failed: exit null, signal SIGKILL,')
    );
  });

  for (const [label, output] of [
    ['empty output', ''],
    ['output that is not a sense usage', 'Debugger attached.\nnothing here\n'],
    ['a usage line with no verb', 'usage: sense <name> [params...]\n'],
  ]) {
    it(`help probe: a successful help with ${label} is rejected with its output`, () => {
      const root = packageWith({ cli: `process.stdout.write(${JSON.stringify(output)});` });
      assert.throws(
        () => probeHelp(cliOf(root)),
        (err: Error) => err.message.startsWith('CLI help probe failed: exit 0, signal none,') && err.message.includes(`stdout ${JSON.stringify(output)}`)
      );
    });
  }

  it('config-version probe: a failed import names the exit code and the error', () => {
    const root = packageWith({ entry: 'throw new Error("entry broke");' });
    assert.throws(
      () => probeConfigVersion(root),
      (err: Error) => err.message.startsWith('config-version probe failed: exit 1, signal none, spawn error none;') && err.message.includes('entry broke')
    );
  });

  it('config-version probe: a missing dist entry is a failure, not version 0', () => {
    const root = packageWith({});
    assert.throws(
      () => probeConfigVersion(root),
      (err: Error) => err.message.startsWith('config-version probe failed: exit 1,') && err.message.includes('ERR_MODULE_NOT_FOUND')
    );
  });

  it('config-version probe: a signalled child names the signal', () => {
    const root = packageWith({ entry: 'process.kill(process.pid, "SIGKILL");' });
    assert.throws(
      () => probeConfigVersion(root),
      (err: Error) => err.message.startsWith('config-version probe failed: exit null, signal SIGKILL,')
    );
  });

  it('config-version probe: an export that is not a whole number is rejected with its output', () => {
    const root = packageWith({ entry: 'export const SUPPORTED_CONFIG_VERSION = "v6";' });
    assert.throws(
      () => probeConfigVersion(root),
      (err: Error) => err.message.startsWith('config-version probe failed: exit 0,') && err.message.includes('stdout "v6"')
    );
  });
});

describe('benchmark structural probes: valid packages select their dialect and config version', () => {
  it('current: the built package reports the search verb and its own config version', () => {
    const help = probeHelp(cliOf(packageRoot));
    assert.match(help, /\bsense search\b/);
    assert.strictEqual(probeConfigVersion(packageRoot), SUPPORTED_CONFIG_VERSION);
  });

  it('legacy: released 0.1.0 answers both probes in the old dialect with config version 1', async () => {
    const root = join(await cachedRelease('0.1.0'), 'node_modules', 'sensemaking');
    const help = probeHelp(cliOf(root));
    assert.ok(!/search/.test(help), 'the oldest release predates the search verb');
    assert.match(help, /\bsense query\b/);
    assert.strictEqual(probeConfigVersion(root), 1);
  });

  it('legacy: a successful import without SUPPORTED_CONFIG_VERSION reports 0', () => {
    const root = packageWith({ entry: 'export const open = () => {};' });
    assert.strictEqual(probeConfigVersion(root), 0);
  });
});
