import assert from 'node:assert';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import semver from 'semver';
import { DUCKDB_FLOOR_VERSION } from '../constants.ts';
import { runCli, runCliAt } from '../lib/cli.ts';
import { declaredFloor, duckdbFloorCli } from '../lib/duckdb-floor.ts';
import { packageRoot, scratchDir } from '../lib/tree.ts';

// Uses the network: the first run installs @duckdb/node-api at exactly the declared 1.x floor into .cache/shared, and later runs reuse it.
// Runs the real built CLI on DuckDB 2 (the dev dependency) and on the floor, over an index the released 0.28.2 wrote and over a cross-version reopen.

const FIXTURE = join(packageRoot, 'test', 'fixtures', 'duckdb-0.28.2');
const FIXTURE_IDENTITY = '@duckdb/node-api@1.5.6-r.2';

function installedIdentity(): string {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'node_modules', '@duckdb', 'node-api', 'package.json'), 'utf8')) as { version: string };
  return `@duckdb/node-api@${manifest.version}`;
}

function fixtureTree(): string {
  const dir = scratchDir('duckdb-fixture');
  for (const name of ['one.md', 'two.md', 'sense.config.json']) cpSync(join(FIXTURE, name), join(dir, name));
  mkdirSync(join(dir, '.sense'));
  writeFileSync(join(dir, '.sense', 'cache.duckdb'), gunzipSync(readFileSync(join(FIXTURE, 'cache.duckdb.gz'))));
  return dir;
}

function freshTree(): string {
  const dir = scratchDir('duckdb-fresh');
  for (const name of ['one.md', 'two.md', 'sense.config.json']) cpSync(join(FIXTURE, name), join(dir, name));
  return dir;
}

type Runner = (args: string[], opts: { cwd: string }) => ReturnType<typeof runCli>;
interface Engine {
  name: string;
  identity: string;
  run: Runner;
}

function engines(): Engine[] {
  return [
    { name: 'DuckDB 2 (dev dependency)', identity: installedIdentity(), run: runCli },
    { name: `floor ${DUCKDB_FLOOR_VERSION}`, identity: `@duckdb/node-api@${DUCKDB_FLOOR_VERSION}`, run: (args, opts) => runCliAt(floorCli, args, opts) },
  ];
}

let floorCli: string;

function recordedIdentity(engine: Engine, dir: string): string {
  const result = engine.run(['sql', "SELECT value FROM meta WHERE key = 'engine_identity'", '--format', 'json'], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  return (JSON.parse(result.stdout) as Array<{ value: string }>)[0].value;
}

function searchPaths(engine: Engine, dir: string): string[] {
  const result = engine.run(['search', 'dog', '--format', 'json'], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  return (JSON.parse(result.stdout) as Array<{ path: string }>).map((row) => row.path);
}

describe('duckdb engine versions', () => {
  before(async () => {
    floorCli = await duckdbFloorCli();
  });

  it('runs the dev dependency on DuckDB 2', () => {
    assert.equal(semver.major(installedIdentity().split('@').pop() as string), 2);
  });

  it('tests the floor the declared range names', () => {
    assert.equal(declaredFloor(), DUCKDB_FLOOR_VERSION);
  });

  it('the floor CLI loads exactly the floor version', () => {
    const floor = engines()[1];
    const tree = freshTree();
    assert.equal(floor.run(['build'], { cwd: tree }).status, 0);
    assert.equal(recordedIdentity(floor, tree), floor.identity);
  });

  for (const engine of ['DuckDB 2 (dev dependency)', `floor ${DUCKDB_FLOOR_VERSION}`]) {
    describe(engine, () => {
      const pick = () => engines().find((e) => e.name === engine) as Engine;

      it('an index written by 0.28.2 is not served without a build, and the error names both engines', () => {
        const tree = fixtureTree();
        const result = pick().run(['search', 'dog', '--no-build'], { cwd: tree });
        assert.equal(result.status, 4);
        assert.ok(result.stderr.includes(`was built with ${FIXTURE_IDENTITY}, but this process loads ${pick().identity}`), result.stderr);
      });

      it('build rebuilds an index written by 0.28.2 under this engine and search finds the note', () => {
        const tree = fixtureTree();
        const built = pick().run(['build'], { cwd: tree });
        assert.equal(built.status, 0, built.stderr);
        assert.ok(built.stderr.includes(`sense: index was built with ${FIXTURE_IDENTITY}; rebuilding it with ${pick().identity}`), built.stderr);
        assert.match(built.stdout + built.stderr, /2 file\(s\) parsed/);
        assert.equal(recordedIdentity(pick(), tree), pick().identity);
        assert.equal(existsSync(join(tree, '.sense', 'cache.duckdb.wal')), false);
        assert.deepEqual(searchPaths(pick(), tree), ['one.md']);
      });
    });
  }

  // The property storage_compatibility_version 'v1.5.0' exists for: an index DuckDB 2 wrote opens under 1.5, so the floor reaches `meta` and rebuilds instead of failing to open.
  it('the floor CLI reopens and rebuilds an index that DuckDB 2 built', () => {
    const [dev, floor] = engines();
    const tree = freshTree();
    assert.equal(dev.run(['build'], { cwd: tree }).status, 0);
    assert.equal(recordedIdentity(dev, tree), dev.identity);
    const refused = floor.run(['search', 'dog', '--no-build'], { cwd: tree });
    assert.equal(refused.status, 4);
    assert.ok(refused.stderr.includes(`was built with ${dev.identity}, but this process loads ${floor.identity}`), refused.stderr);
    const rebuilt = floor.run(['build'], { cwd: tree });
    assert.equal(rebuilt.status, 0, rebuilt.stderr);
    assert.ok(rebuilt.stderr.includes(`sense: index was built with ${dev.identity}; rebuilding it with ${floor.identity}`), rebuilt.stderr);
    assert.deepEqual(searchPaths(floor, tree), ['one.md']);
  });
});
