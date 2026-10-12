import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'assert';
import semver from 'semver';
import { SenseError } from '../../../src/errors.ts';
import { DUCKDB_PACKAGE } from '../../../src/store/duckdb/native.ts';
import { loadOrInstall, type NativeDescriptor } from '../../../src/store/native.ts';
import { TURSO_PACKAGE } from '../../../src/store/turso/native.ts';
import { packageRoot, scratchDir } from '../../lib/tree.ts';

const DESCRIPTOR: NativeDescriptor = { store: 'test-store', pkg: 'test-store-native-pkg', sizeHint: '~1MB', range: '^1.0.0' };

// Captures the loader's stderr notices for one call.
async function notices<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (message: unknown) => lines.push(String(message));
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = original;
  }
}

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
        assert.ok(err.message.includes(`${DESCRIPTOR.pkg}@${DESCRIPTOR.range}, and installing it automatically failed`));
        assert.ok(err.message.includes(`npm install ${DESCRIPTOR.pkg}@${DESCRIPTOR.range}`));
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
          assert.ok(err.message.includes(`${DESCRIPTOR.pkg}@${DESCRIPTOR.range}, and installing it automatically failed`));
          assert.match(err.message, /read-only or owned by another user/);
          assert.ok(err.message.includes(`npm install ${DESCRIPTOR.pkg}@${DESCRIPTOR.range}`));
          return true;
        }
      );
    } finally {
      restore();
    }
  });

  it('installs the tested range of a real, tiny, already-published package and loads it, working around Node caching the first bare-specifier miss', async () => {
    const nodeModulesPath = scratchDir('native-install-success');
    const fixture = { ...DESCRIPTOR, range: '~4.0.0' };
    const { result, lines } = await notices(() => loadOrInstall<{ default: (n: number) => boolean }>(fixture, nodeModulesPath, 'is-natural-number'));
    assert.equal(result.api.default(4), true);
    assert.equal(result.api.default(-1), false);
    const installed = JSON.parse(readFileSync(join(nodeModulesPath, 'is-natural-number', 'package.json'), 'utf8')) as { version: string };
    assert.equal(result.version, installed.version);
    assert.ok(semver.satisfies(installed.version, fixture.range));
    assert.deepEqual(lines, [`sense: store "test-store" needs ${DESCRIPTOR.pkg}@~4.0.0; installing it now (one-time download, ~1MB)...`]);
  });

  it('uses an already-resolvable version inside the tested range without notices', async () => {
    const installed = (JSON.parse(readFileSync(join(packageRoot, 'node_modules', 'semver', 'package.json'), 'utf8')) as { version: string }).version;
    const { result, lines } = await notices(() => loadOrInstall({ ...DESCRIPTOR, pkg: 'semver', range: `^${semver.major(installed)}.0.0` }, scratchDir('native-in-range')));
    assert.equal(result.version, installed);
    assert.deepEqual(lines, []);
  });

  it('uses an already-resolvable version outside the tested range and reports it', async () => {
    const installed = (JSON.parse(readFileSync(join(packageRoot, 'node_modules', 'semver', 'package.json'), 'utf8')) as { version: string }).version;
    const range = `^${semver.major(installed) - 1}.0.0`;
    const { result, lines } = await notices(() => loadOrInstall({ ...DESCRIPTOR, pkg: 'semver', range }, scratchDir('native-out-of-range')));
    assert.equal(result.version, installed);
    assert.deepEqual(lines, [`sense: store "test-store" using semver@${installed} (tested ${range})`]);
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
        { store: 'built-' + mode, pkg: 'built-native-pkg', sizeHint: 'tiny', range: '^4.0.0' },
        nodeModulesPath,
        'is-natural-number'
      );
      const check = loaded.api.default;
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

  it('loads the installed DuckDB native API without an exact installed-version restriction', async () => {
    const { duckdbApi } = await import('../../../src/store/duckdb/native.ts');
    assert.equal(typeof (await duckdbApi()).DuckDBInstance, 'function');
  });
});

// The published optional-peer contract tracks what the suite installs: `ncu -u -m` moves devDependencies, and this fails until peerDependencies follow.
describe('optional native peer contract', () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    devDependencies: Record<string, string>;
    peerDependencies: Record<string, string>;
    peerDependenciesMeta: Record<string, { optional?: boolean }>;
  };

  for (const pkg of [DUCKDB_PACKAGE, TURSO_PACKAGE]) {
    it(`declares ${pkg} as an optional peer with the tested devDependency range`, () => {
      assert.equal(manifest.peerDependenciesMeta[pkg]?.optional, true);
      assert.equal(manifest.peerDependencies[pkg], manifest.devDependencies[pkg], `${pkg}: devDependencies moved to ${manifest.devDependencies[pkg]}; update peerDependencies once the store suites pass`);
      const installed = (JSON.parse(readFileSync(join(packageRoot, 'node_modules', ...pkg.split('/'), 'package.json'), 'utf8')) as { version: string }).version;
      assert.ok(semver.satisfies(installed, manifest.peerDependencies[pkg]), `${pkg}@${installed} is outside ${manifest.peerDependencies[pkg]}`);
    });
  }

  it('declares exactly the store packages as optional peers', () => {
    assert.deepEqual(Object.keys(manifest.peerDependencies).sort(), [DUCKDB_PACKAGE, TURSO_PACKAGE].sort());
  });
});
