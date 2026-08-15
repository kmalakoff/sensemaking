import assert from 'assert';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { runCli } from '../lib/cli.ts';
import { tmpTree, writeNote } from '../lib/tree.ts';

function writeConfig(dir: string, config: Record<string, unknown>): void {
  writeFileSync(join(dir, 'sense.config.json'), JSON.stringify(config));
}

function makeTree(): string {
  const dir = tmpTree();
  writeNote(dir, 'floor.md', { frontmatter: { title: 'Pricing floor', status: 'active' }, body: 'The price floor is 100 credits. See [[context]] for why.' });
  writeNote(dir, 'context.md', { frontmatter: { title: 'Context', status: 'active' }, body: 'Background that never mentions the c-word or the s-word.' });
  writeNote(dir, 'archived.md', { frontmatter: { title: 'Old', status: 'archived' }, body: 'Old price discussion, superseded.' });
  writeNote(dir, 'unrelated.md', { frontmatter: { title: 'Gardening', status: 'active' }, body: 'Gardening notes.' });
  return dir;
}

describe('saved finds', () => {
  it('sense <name> --format json matches sense find --format json shape, and respects saved k', () => {
    const dir = makeTree();
    writeConfig(dir, { version: 2, scan: { include: ['*.md'] }, queries: { hot: { find: 'price', k: 2 } } });

    const saved = runCli(['hot', '--format', 'json'], { cwd: dir });
    assert.equal(saved.status, 0, saved.stderr);
    const savedRows = JSON.parse(saved.stdout);

    const direct = runCli(['find', 'price', '--k', '2', '--format', 'json'], { cwd: dir });
    assert.equal(direct.status, 0, direct.stderr);
    const directRows = JSON.parse(direct.stdout);

    assert.deepEqual(savedRows, directRows);
    assert.ok(savedRows.length <= 2, `expected saved k=2 to cap rows, got ${savedRows.length}`);
  });

  it('--where on the invocation overrides the saved where', () => {
    const dir = makeTree();
    writeConfig(dir, { version: 2, scan: { include: ['*.md'] }, queries: { hot: { find: 'price', where: "f.status = 'archived'" } } });

    const scoped = runCli(['hot', '--format', 'json'], { cwd: dir });
    assert.equal(scoped.status, 0, scoped.stderr);
    const scopedRows = JSON.parse(scoped.stdout) as Array<{ path: string }>;
    assert.ok(
      scopedRows.every((r) => r.path === 'archived.md'),
      `saved where should scope to archived.md: ${JSON.stringify(scopedRows)}`
    );

    const overridden = runCli(['hot', '--where', "f.status = 'active'", '--format', 'json'], { cwd: dir });
    assert.equal(overridden.status, 0, overridden.stderr);
    const overriddenRows = JSON.parse(overridden.stdout) as Array<{ path: string }>;
    assert.ok(overriddenRows.some((r) => r.path === 'floor.md'));
    assert.ok(overriddenRows.every((r) => r.path !== 'archived.md'));
  });

  it('semantic: true on a tree without embed exits 1 naming features.embed', () => {
    const dir = makeTree();
    writeConfig(dir, { version: 2, scan: { include: ['*.md'] }, queries: { hot: { find: 'price', semantic: true } } });

    const result = runCli(['hot'], { cwd: dir });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /features\.embed/);
  });

  it('a positional parameter on a saved find exits 2', () => {
    const dir = makeTree();
    writeConfig(dir, { version: 2, scan: { include: ['*.md'] }, queries: { hot: { find: 'price' } } });

    const result = runCli(['hot', 'extra'], { cwd: dir });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /no positional parameters/);
  });

  it('a saved find missing "find" is a named config error, not a TypeError', () => {
    const dir = makeTree();
    writeConfig(dir, { version: 2, scan: { include: ['*.md'] }, queries: { hot: { k: 5 } } });

    const result = runCli(['--list'], { cwd: dir });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /queries\.hot\.find must be a string/);
    assert.ok(!result.stderr.includes('TypeError'), result.stderr);
  });

  it('a saved find with an unknown key is a named config error', () => {
    const dir = makeTree();
    writeConfig(dir, { version: 2, scan: { include: ['*.md'] }, queries: { hot: { find: 'price', bogus: true } } });

    const result = runCli(['--list'], { cwd: dir });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /queries\.hot has unknown key\(s\) bogus/);
  });

  it('a saved find with a non-positive-integer k is a named config error', () => {
    const dir = makeTree();
    for (const k of [0, -1, 1.5]) {
      writeConfig(dir, { version: 2, scan: { include: ['*.md'] }, queries: { hot: { find: 'price', k } } });
      const result = runCli(['--list'], { cwd: dir });
      assert.equal(result.status, 1, `k=${k} should be rejected`);
      assert.match(result.stderr, /queries\.hot\.k must be a positive integer/);
    }
  });

  it('checks pointing at a saved find is a config error', () => {
    const dir = makeTree();
    writeConfig(dir, { version: 2, scan: { include: ['*.md'] }, queries: { hot: { find: 'price' } }, checks: { hot: 'empty' } });

    const result = runCli(['--list'], { cwd: dir });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /checks names "hot", which is a saved find/);
  });

  it('check reports semantic-without-embed as a failure, without executing the find; --list marks the saved find', () => {
    const dir = makeTree();
    writeConfig(dir, { version: 2, scan: { include: ['*.md'] }, queries: { hot: { find: 'price', semantic: true } } });

    const checked = runCli(['check'], { cwd: dir });
    assert.equal(checked.status, 1);
    assert.match(checked.stdout, /hot.*FAILED: semantic requested but features\.embed is off/);

    const listed = runCli(['--list'], { cwd: dir });
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /hot\s+\(find\)/);
  });

  it('--semantic on a saved find reaches find(): embed-less tree errors instead of silently going lexical', () => {
    const dir = makeTree();
    writeConfig(dir, { version: 2, scan: { include: ['*.md'] }, queries: { hot: { find: 'price' } } });

    const plain = runCli(['hot'], { cwd: dir });
    assert.equal(plain.status, 0, plain.stderr);

    const upgraded = runCli(['hot', '--semantic'], { cwd: dir });
    assert.equal(upgraded.status, 1, 'the flag must not be silently dropped');
    assert.match(upgraded.stderr, /embed/);
  });

  it('--k rejects zero, negatives, and fractions on saved finds and on find itself', () => {
    const dir = makeTree();
    writeConfig(dir, { version: 2, scan: { include: ['*.md'] }, queries: { hot: { find: 'price' } } });
    for (const bad of ['0', '-1', '5.9']) {
      assert.equal(runCli(['hot', '--k', bad], { cwd: dir }).status, 2, `saved find --k ${bad}`);
      assert.equal(runCli(['find', 'price', '--k', bad], { cwd: dir }).status, 2, `find --k ${bad}`);
    }
  });

  it('check probes a saved find lexically: a typo in where fails check, not the eventual caller', () => {
    const dir = makeTree();
    writeConfig(dir, { version: 2, scan: { include: ['*.md'] }, queries: { hot: { find: 'price', where: "f.stauts = 'active'" } } });

    const result = runCli(['check'], { cwd: dir });
    assert.equal(result.status, 1, `expected check to fail: ${result.stdout}`);
    assert.match(result.stdout, /hot.*FAILED/);
    assert.match(result.stdout, /stauts/);
  });

  it('a string-valued query is still listed plainly, without the (find) marker', () => {
    const dir = makeTree();
    writeConfig(dir, { version: 2, scan: { include: ['*.md'] }, queries: { plain: 'SELECT path FROM frontmatter' } });

    const listed = runCli(['--list'], { cwd: dir });
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(listed.stdout.trim(), 'plain');
  });
});
