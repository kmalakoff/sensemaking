import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'assert';
import { SenseError } from '../../../src/errors.ts';
import { loadOrInstall, type NativeDescriptor } from '../../../src/store/native.ts';
import { packageRoot, scratchDir } from '../../lib/scratch.ts';

const DESCRIPTOR: NativeDescriptor = { store: 'test-store', pkg: 'test-store-native-pkg', sizeHint: '~1MB' };

// chmod is a no-op on Windows directories, so deny write with an ACL there; returns a restore fn.
function makeUnwritable(dir: string): () => void {
  if (process.platform === 'win32') {
    const deny = spawnSync('icacls', [dir, '/deny', '*S-1-1-0:(WD,AD)'], { encoding: 'utf8' });
    if (deny.status !== 0) throw new Error(`icacls /deny failed (status ${deny.status}): ${deny.error?.message ?? [deny.stdout, deny.stderr].filter(Boolean).join(' ').trim()}`);
    return () => {
      const remove = spawnSync('icacls', [dir, '/remove:d', '*S-1-1-0'], { encoding: 'utf8' });
      if (remove.status !== 0) throw new Error(`icacls /remove:d failed (status ${remove.status}): ${remove.error?.message ?? [remove.stdout, remove.stderr].filter(Boolean).join(' ').trim()}`);
    };
  }
  chmodSync(dir, 0o444);
  return () => chmodSync(dir, 0o755);
}

// Real failures, not simulated: a genuinely nonexistent package (import and npm install both fail)
// and a genuinely unwritable directory (cache succeeds, symlink-into-place fails); a substitute descriptor/importName avoids downloading a real native binding.
describe('loadOrInstall', () => {
  it('names the install failure and the manual escape hatch when the package cannot be found at all', async () => {
    const nodeModulesPath = scratchDir('native-install-missing');
    const missing = `sensemaking-test-does-not-exist-${randomUUID()}`;
    await assert.rejects(
      () => loadOrInstall(DESCRIPTOR, nodeModulesPath, missing),
      (err: unknown) => {
        assert.ok(err instanceof SenseError);
        assert.equal(err.code, 'STORE_DEPENDENCY_MISSING');
        assert.match(err.message, new RegExp(`${DESCRIPTOR.pkg}, and installing it automatically failed`));
        assert.match(err.message, new RegExp(`npm install ${DESCRIPTOR.pkg}`));
        return true;
      }
    );
  });

  it('names the install failure when the target node_modules cannot be written to', async () => {
    const parent = scratchDir('native-install-readonly');
    const nodeModulesPath = join(parent, 'node_modules');
    mkdirSync(nodeModulesPath, { recursive: true });
    const restore = makeUnwritable(nodeModulesPath);
    try {
      // The denial must actually bind, or the scenario below never triggers.
      assert.throws(() => mkdirSync(join(nodeModulesPath, 'probe')));
      // A real, tiny, already-published package this project never resolves on its own (so the first
      // import genuinely fails), isolating the failure to the read-only symlink-into-place step.
      await assert.rejects(
        () => loadOrInstall(DESCRIPTOR, nodeModulesPath, 'is-natural-number'),
        (err: unknown) => {
          assert.ok(err instanceof SenseError);
          assert.equal(err.code, 'STORE_DEPENDENCY_MISSING');
          assert.match(err.message, new RegExp(`${DESCRIPTOR.pkg}, and installing it automatically failed`));
          assert.match(err.message, /read-only or owned by another user/);
          assert.match(err.message, new RegExp(`npm install ${DESCRIPTOR.pkg}`));
          return true;
        }
      );
    } finally {
      restore();
    }
  });

  it('installs a real, tiny, already-published package and loads it, working around Node caching the first bare-specifier miss', async () => {
    const nodeModulesPath = scratchDir('native-install-success');
    const fixture = { ...DESCRIPTOR, version: '4.0.1', installSpec: 'is-natural-number@4.0.1' };
    const mod = (await loadOrInstall(fixture, nodeModulesPath, 'is-natural-number')) as { default: (n: number) => boolean };
    assert.equal(typeof mod.default, 'function');
    assert.equal(mod.default(4), true);
    assert.equal(mod.default(-1), false);
    const installed = JSON.parse(readFileSync(join(nodeModulesPath, 'is-natural-number', 'package.json'), 'utf8')) as { version?: string };
    assert.equal(installed.version, fixture.version);
  });

  it('loads the installed package through both built module formats with the import namespace shape', () => {
    const script = `
      import { createRequire } from 'node:module';
      import { pathToFileURL } from 'node:url';
      const mode = process.argv[1];
      const nodeModulesPath = process.argv[2];
      const builtPath = process.argv[3];
      const native = mode === 'esm'
        ? await import(pathToFileURL(builtPath).href)
        : createRequire(import.meta.url)(builtPath);
      const loaded = await native.loadOrInstall(
        { store: 'built-' + mode, pkg: 'built-native-pkg', sizeHint: 'tiny' },
        nodeModulesPath,
        'is-natural-number'
      );
      const check = loaded.default;
      console.log(JSON.stringify({ defaultType: typeof check, positive: check(4), negative: check(-1) }));
    `;

    for (const mode of ['esm', 'cjs'] as const) {
      const nodeModulesPath = scratchDir(`native-built-${mode}`);
      const builtPath = join(packageRoot, 'dist', mode, 'store', 'native.js');
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, mode, nodeModulesPath, builtPath], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout.trim()), { defaultType: 'function', positive: true, negative: false });
    }
  });

  it('loads an already-installed exact-version native package without invoking the installer', async () => {
    const { DUCKDB_INSTALL_SPEC, DUCKDB_PACKAGE, DUCKDB_VERSION } = await import('../../../src/store/duckdb/native.ts');
    assert.equal(DUCKDB_INSTALL_SPEC, `${DUCKDB_PACKAGE}@${DUCKDB_VERSION}`);
    const loaded = await loadOrInstall({ store: 'duckdb', pkg: DUCKDB_PACKAGE, sizeHint: '~110MB', version: DUCKDB_VERSION, installSpec: DUCKDB_INSTALL_SPEC }, join(packageRoot, 'node_modules'));
    assert.equal(typeof (loaded as { DuckDBInstance?: unknown }).DuckDBInstance, 'function');
  });

  it('fails closed before installation for incompatible, missing, malformed, and versionless manifests', async () => {
    for (const [label, manifest] of [
      ['incompatible', JSON.stringify({ name: DESCRIPTOR.pkg, version: '0.0.1' })],
      ['missing', undefined],
      ['malformed', '{not-json'],
      ['versionless', JSON.stringify({ name: DESCRIPTOR.pkg })],
    ] as const) {
      const nodeModulesPath = scratchDir(`native-${label}-version`);
      const packageDir = join(nodeModulesPath, ...DESCRIPTOR.pkg.split('/'));
      mkdirSync(packageDir, { recursive: true });
      if (manifest !== undefined) writeFileSync(join(packageDir, 'package.json'), manifest);
      await assert.rejects(
        () => loadOrInstall({ ...DESCRIPTOR, version: '9.9.9', installSpec: `${DESCRIPTOR.pkg}@9.9.9` }, nodeModulesPath),
        (err: unknown) => {
          assert.ok(err instanceof SenseError);
          assert.equal(err.code, 'STORE_DEPENDENCY_MISSING');
          assert.ok(err.message.includes(`npm install ${DESCRIPTOR.pkg}@9.9.9`));
          return true;
        }
      );
    }
  });
});
