import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'assert';
import { releaseChanges } from '../../benchmark/lib/changes.mjs';
import { assertCompatibleSelection, profileReasons } from '../../benchmark/lib/gates.mjs';
import { packageRoot, scratchDir } from '../lib/scratch.ts';

function git(root: string, ...argv: string[]) {
  const result = spawnSync('git', argv, { cwd: root, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
}

function realGateFixture(prefix: string) {
  const root = scratchDir(prefix);
  for (const path of ['benchmark', 'dist', '.gitignore', 'package.json', 'package-lock.json']) cpSync(join(packageRoot, path), join(root, path), { recursive: true });
  appendFileSync(join(root, '.gitignore'), '\nnode_modules\n');
  git(root, 'init');
  git(root, 'config', 'user.email', 'fixture@example.com');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'fixture');
  git(root, 'tag', 'v1');
  symlinkSync(join(packageRoot, 'node_modules'), join(root, 'node_modules'), 'junction');
  return root;
}

describe('release assessment profiles', () => {
  it('keeps ordinary proportional and makes deep expand only staged assessment work', () => {
    assert.deepEqual([...profileReasons(['README.md'], 'v1', 'ordinary').keys()], []);
    assert.deepEqual([...profileReasons(['src/output/output.ts'], 'v1', 'ordinary').keys()], ['baseline', 'quality-revalidation']);
    const searchError = profileReasons(['src/output/search-error.ts'], 'v1', 'ordinary');
    for (const gate of ['baseline', 'quality-baseline']) assert.equal(searchError.has(gate), true, gate);
    for (const gate of ['scale', 'fever']) assert.equal(searchError.has(gate), false, gate);
    const affected = profileReasons(['src/store/new-ranking.ts'], 'v1', 'ordinary');
    for (const gate of ['store-dump', 'baseline', 'quality-baseline']) assert.equal(affected.has(gate), true, gate);
    for (const gate of ['scale', 'fever']) assert.equal(affected.has(gate), false, gate);
    const deep = profileReasons(['README.md'], 'v1', 'deep');
    assert.deepEqual([...deep.keys()], ['baseline', 'scale', 'quality-baseline', 'fever']);
    for (const gate of ['test-engines', 'live-suite', 'store-dump', 'oracle']) assert.equal(deep.has(gate), false, gate);
  });

  it('selects all deep stages for a new unclassified source area', () => {
    const reasons = profileReasons(['src/new-capability/worker.ts'], 'v1', 'ordinary');
    for (const gate of ['baseline', 'scale', 'quality-baseline', 'fever']) {
      assert.equal(reasons.has(gate), true, gate);
      assert.match(reasons.get(gate)?.join('\n') ?? '', /unclassified source path/);
    }
  });

  it('revalidates evaluator changes without scheduling fresh retrieval or scale', () => {
    for (const path of ['benchmark/report.mjs', 'benchmark/lib/metrics.mjs', 'benchmark/lib/portable-quality.mjs']) {
      const reasons = profileReasons([path], 'v1', 'ordinary');
      assert.equal(reasons.has('baseline'), true, path);
      assert.equal(reasons.has('quality-revalidation'), true, path);
      for (const gate of ['scale', 'quality-baseline', 'fever']) assert.equal(reasons.has(gate), false, `${path}: ${gate}`);
    }
  });

  it('includes untracked files, deletions, and both sides of renames', () => {
    const root = scratchDir('release-changes');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'deleted.ts'), 'old\n');
    writeFileSync(join(root, 'src', 'renamed-old.ts'), 'rename\n');
    git(root, 'init');
    git(root, 'config', 'user.email', 'fixture@example.com');
    git(root, 'config', 'user.name', 'Fixture');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'fixture');
    git(root, 'tag', 'v1');
    git(root, 'mv', 'src/renamed-old.ts', 'src/renamed-new.ts');
    git(root, 'rm', 'src/deleted.ts');
    writeFileSync(join(root, 'src', 'untracked.ts'), 'new\n');
    const changes = releaseChanges(root);
    assert.equal(changes.lastTag, 'v1');
    assert.deepEqual(changes.paths, ['src/deleted.ts', 'src/renamed-new.ts', 'src/renamed-old.ts', 'src/untracked.ts']);
    assert.deepEqual(changes.untracked, ['src/untracked.ts']);
    assert.equal(changes.packageJson, null);
  });

  it('keeps package provenance while separating scripts and versions from dependency changes', () => {
    const root = scratchDir('release-package-changes');
    const packagePath = join(root, 'package.json');
    const lockPath = join(root, 'package-lock.json');
    const lock = (version: string, dependency: string) => ({ name: 'fixture', version, lockfileVersion: 3, packages: { '': { name: 'fixture', version, dependencies: { retrieval: dependency } }, 'node_modules/retrieval': { version: dependency } } });
    writeFileSync(packagePath, `${JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'old' }, dependencies: { retrieval: '1.0.0' } }, null, 2)}\n`);
    writeFileSync(lockPath, `${JSON.stringify(lock('1.0.0', '1.0.0'), null, 2)}\n`);
    git(root, 'init');
    git(root, 'config', 'user.email', 'fixture@example.com');
    git(root, 'config', 'user.name', 'Fixture');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'fixture');
    git(root, 'tag', 'v1');

    writeFileSync(packagePath, `${JSON.stringify({ name: 'fixture', version: '1.0.1', scripts: { test: 'new' }, dependencies: { retrieval: '1.0.0' } }, null, 2)}\n`);
    writeFileSync(lockPath, `${JSON.stringify(lock('1.0.1', '1.0.0'), null, 2)}\n`);
    const metadata = releaseChanges(root);
    assert.deepEqual(metadata.paths, ['package-lock.json', 'package.json']);
    assert.deepEqual(metadata.packageJson, { classification: 'version-scripts-only', changed_fields: ['scripts', 'version'] });
    assert.deepEqual(metadata.packageLock, { classification: 'version-metadata-only' });
    const metadataReasons = profileReasons(metadata.paths, metadata.lastTag, 'ordinary', metadata.packageJson, metadata.packageLock);
    assert.deepEqual([...metadataReasons.keys()], ['test-engines', 'baseline', 'quality-revalidation']);

    writeFileSync(packagePath, `${JSON.stringify({ name: 'fixture', version: '1.0.1', scripts: { test: 'new' }, dependencies: { retrieval: '2.0.0' } }, null, 2)}\n`);
    writeFileSync(lockPath, `${JSON.stringify(lock('1.0.1', '2.0.0'), null, 2)}\n`);
    const dependency = releaseChanges(root);
    assert.equal(dependency.packageJson?.classification, 'dependency');
    assert.equal(dependency.packageLock?.classification, 'dependency-or-other');
    const dependencyReasons = profileReasons(dependency.paths, dependency.lastTag, 'ordinary', dependency.packageJson, dependency.packageLock);
    for (const gate of ['baseline', 'scale', 'quality-baseline', 'fever']) assert.equal(dependencyReasons.has(gate), true, gate);

    writeFileSync(packagePath, `${JSON.stringify({ name: 'fixture', version: '1.0.1', scripts: { test: 'new' }, dependencies: { retrieval: '1.0.0' }, overrides: { retrieval: '2.0.0' } }, null, 2)}\n`);
    writeFileSync(lockPath, `${JSON.stringify(lock('1.0.1', '1.0.0'), null, 2)}\n`);
    const unclassified = releaseChanges(root);
    assert.equal(unclassified.packageJson?.classification, 'unclassified');
    const unclassifiedReasons = profileReasons(unclassified.paths, unclassified.lastTag, 'ordinary', unclassified.packageJson, unclassified.packageLock);
    for (const gate of ['baseline', 'scale', 'quality-baseline', 'fever']) assert.equal(unclassifiedReasons.has(gate), true, gate);

    writeFileSync(packagePath, '{');
    const unreadable = releaseChanges(root);
    assert.equal(unreadable.packageJson?.classification, 'unclassified');
    const unreadableReasons = profileReasons(unreadable.paths, unreadable.lastTag, 'ordinary', unreadable.packageJson, unreadable.packageLock);
    for (const gate of ['baseline', 'scale', 'quality-baseline', 'fever']) assert.equal(unreadableReasons.has(gate), true, gate);

    writeFileSync(packagePath, 'null');
    assert.equal(releaseChanges(root).packageJson?.classification, 'unclassified');
  });

  it('allows requirement expansion on resume and rejects narrowing or changed inputs', () => {
    const prior = { last_tag: 'v1', changed_paths: ['src/output/output.ts'], effective_requirements: { baseline: ['src/output/output.ts'] } };
    const expanded = profileReasons(['src/output/output.ts'], 'v1', 'deep');
    assert.doesNotThrow(() => assertCompatibleSelection(prior, { lastTag: 'v1', paths: ['src/output/output.ts'], reasons: expanded, profile: 'deep' }));
    assert.throws(() => assertCompatibleSelection({ ...prior, effective_requirements: { ...prior.effective_requirements, scale: ['deep profile'] } }, { lastTag: 'v1', paths: ['src/output/output.ts'], reasons: profileReasons(['src/output/output.ts'], 'v1', 'ordinary'), profile: 'ordinary' }), /requires scale/);
    assert.throws(() => assertCompatibleSelection(prior, { lastTag: 'v2', paths: ['src/output/output.ts'], reasons: expanded, profile: 'deep' }), /incompatible changed-path/);
  });

  it('prints an actual dry-run with the effective profile, reasons, and estimate', () => {
    const root = realGateFixture('gate-dry-run');
    const sittingsDir = join(root, '.tmp', 'sittings');
    assert.equal(existsSync(sittingsDir), false);
    const result = spawnSync(process.execPath, [join(root, 'benchmark', 'gate.mjs'), '--dry-run', '--profile', 'ordinary'], { cwd: root, encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^profile: ordinary/m);
    assert.match(result.stdout, /^diff since \S+: \d+ path\(s\) changed$/m);
    assert.match(result.stdout, /^ {2}validate: OWED/m);
    assert.match(result.stdout, /^prior execution estimate: ~[\d.]+ min known/m);
    assert.match(result.stdout, /^estimate basis:/m);
    assert.equal(existsSync(sittingsDir), false);
  });

  it('refuses an ordinary gate with unknown cost before creating a sitting', function () {
    this.timeout(30_000);
    const root = realGateFixture('gate-cost-refusal');
    mkdirSync(join(root, 'src', 'embed'), { recursive: true });
    writeFileSync(join(root, 'src', 'embed', 'changed.ts'), 'export const changed = true;\n');
    const sittingsDir = join(root, '.tmp', 'sittings');
    assert.equal(existsSync(sittingsDir), false);

    const result = spawnSync(process.execPath, [join(root, 'benchmark', 'gate.mjs'), '--profile', 'ordinary'], { cwd: root, encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stdout, /^ {2}live-suite: OWED \(cost unknown\)$/m);
    assert.match(result.stderr, /ordinary assessment stopped before execution/);
    assert.match(result.stderr, /Run with --profile deep/);
    assert.equal(existsSync(sittingsDir), false);
  });

  it('documents profile behavior in CLI help', () => {
    const result = spawnSync(process.execPath, ['benchmark/gate.mjs', '--help'], { cwd: packageRoot, encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--profile ordinary\|deep/);
    assert.match(result.stdout, /ordinary uses portable NFCorpus/);
    assert.match(result.stdout, /deep adds FEVER, scale\/stress, and legacy OR-bag continuity/);
    assert.match(result.stdout, /dry-run resolves retained-quality availability/);
  });
});
