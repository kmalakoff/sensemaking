import assert from 'assert';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const dirname2 = () => dirname(fileURLToPath(import.meta.url));

import type { Config, Row } from 'sensemaking';
import { find, open, peek, vaultMap } from 'sensemaking';

function tmpVault(): string {
  return mkdtempSync(join(tmpdir(), 'sense-verbs-'));
}

function write(baseDir: string, relPath: string, body: string, frontmatter: Record<string, unknown> = {}): void {
  const lines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  writeFileSync(join(baseDir, relPath), `---\n${lines.join('\n')}\n---\n\n${body}\n`);
}

function makeVault(): string {
  const baseDir = tmpVault();
  write(baseDir, 'floor.md', 'The price floor is 100 credits. See [[context]] for why.', { title: 'Pricing floor', status: 'active' });
  write(baseDir, 'context.md', 'Background that never mentions the c-word or the s-word.', { title: 'Context', status: 'active' });
  write(baseDir, 'archived.md', 'Old price discussion, superseded.', { title: 'Old', status: 'archived' });
  write(baseDir, 'unrelated.md', 'Gardening notes.', { title: 'Gardening', status: 'active' });
  return baseDir;
}

function openVault(baseDir: string, features?: Config['features']) {
  return open({ scan: { include: ['**/*.md'] }, queries: {}, features, baseDir, configPath: null });
}

describe('find', () => {
  it('BM25 matches carry via=match with a snippet', () => {
    const { db, cfg } = openVault(makeVault());
    const rows = find(db, cfg, 'price') as Array<{ path: string; via: string; hit: string }>;
    const floor = rows.find((r) => r.path === 'floor.md');
    assert.ok(floor, `expected floor.md in results: ${JSON.stringify(rows.map((r) => r.path))}`);
    assert.ok(floor.via.includes('match'));
    assert.ok(/«pric/i.test(floor.hit), `no highlighted match in: ${floor.hit}`);
  });

  it('link expansion surfaces a connected note that never contains the terms, via=link', () => {
    const { db, cfg } = openVault(makeVault());
    const rows = find(db, cfg, 'price') as Array<{ path: string; via: string }>;
    const connected = rows.find((r) => r.path === 'context.md');
    assert.ok(connected, `expected context.md in results: ${JSON.stringify(rows.map((r) => r.path))}`);
    assert.equal(connected.via, 'link');
  });

  it('--where composes a frontmatter filter with the fused ranking', () => {
    const { db, cfg } = openVault(makeVault());
    const rows = find(db, cfg, 'price', { where: "f.status = 'active'" }) as Array<{ path: string }>;
    assert.ok(rows.every((r) => r.path !== 'archived.md'));
    assert.ok(rows.some((r) => r.path === 'floor.md'));
  });

  it('invalid FTS5 syntax falls back to OR over words instead of erroring', () => {
    const { db, cfg } = openVault(makeVault());
    const rows = find(db, cfg, 'what is the price floor?') as Array<{ path: string }>;
    assert.ok(rows.some((r) => r.path === 'floor.md'));
  });

  it('with links disabled it degrades to BM25-only', () => {
    const { db, cfg } = openVault(makeVault(), { links: false });
    const rows = find(db, cfg, 'price') as Array<{ path: string; via: string }>;
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.via === 'match'));
    assert.ok(!rows.some((r) => r.path === 'context.md'));
  });
});

describe('vaultMap', () => {
  it('reports counts, field coverage, hubs, and recent', () => {
    const { db, cfg } = openVault(makeVault());
    const result = vaultMap(db, cfg);
    assert.equal(result.docs.count, 4);
    const status = result.fields.find((f: Row) => f.field === 'status');
    assert.equal(status?.coverage, 4);
    assert.ok(!result.fields.some((f: Row) => f.field === '_rank'), 'internal columns are not fields');
    assert.ok(
      (result.hubs as Array<{ path: string }>).some((h) => h.path === 'context.md'),
      'the linked-to note is a hub'
    );
    assert.equal(result.recent.length, 4);
  });

  it('without rank there are no hubs, everything else stands', () => {
    const { db, cfg } = openVault(makeVault(), { rank: false });
    const result = vaultMap(db, cfg);
    assert.deepEqual(result.hubs, []);
    assert.equal(result.docs.count, 4);
  });
});

describe('peek', () => {
  function structured(): string {
    const baseDir = tmpVault();
    write(baseDir, 'note.md', '# Alpha\n\nprose\n\n## Beta\n\nmore [[other]] prose\n', { title: 'Structured', tags: ['x'] });
    write(baseDir, 'other.md', 'links back to [[note]]');
    return baseDir;
  }

  it('returns frontmatter, outline with line ranges, and links both ways', () => {
    const { db, cfg } = openVault(structured());
    const result = peek(db, cfg, 'note.md');
    assert.equal(result.frontmatter.title, 'Structured');
    assert.equal(result.sections.length, 2);
    assert.equal(result.sections[0].heading, 'Alpha');
    assert.ok((result.sections[0].start_line as number) > 0);
    assert.deepEqual(result.outbound, ['other.md']);
    assert.deepEqual(result.backlinks, ['other.md']);
    assert.ok(result.tokens > 0);
  });

  it('resolves a bare basename when unique', () => {
    const { db, cfg } = openVault(structured());
    const result = peek(db, cfg, 'note');
    assert.equal(result.path, 'note.md');
  });

  it('unknown path throws with a message', () => {
    const { db, cfg } = openVault(structured());
    assert.throws(() => peek(db, cfg, 'missing'), /no note matches/);
  });
});

describe('peek stays bounded', () => {
  it('caps link lists at 20 and reports totals', () => {
    const baseDir = tmpVault();
    write(baseDir, 'hub.md', 'the target everyone cites');
    for (let i = 0; i < 30; i++) write(baseDir, `n${String(i).padStart(2, '0')}.md`, 'cites [[hub]]');

    const { db, cfg } = openVault(baseDir);
    const result = peek(db, cfg, 'hub.md');
    assert.equal(result.backlinksTotal, 30);
    assert.equal(result.backlinks.length, 20);
  });
});

describe('--version', () => {
  it('prints the package.json version', async () => {
    const { spawnSync } = await import('child_process');
    const { readFileSync } = await import('fs');
    const cliPath = join(dirname2(), '..', '..', 'bin', 'cli.js');
    const pkg = JSON.parse(readFileSync(join(dirname2(), '..', '..', 'package.json'), 'utf8'));
    const result = spawnSync(process.execPath, [cliPath, '--version'], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), `v${pkg.version}`);
  });
});
