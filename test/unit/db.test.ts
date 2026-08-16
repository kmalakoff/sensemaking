import assert from 'assert';
import { cpSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { open } from 'sensemaking';
import { fileURLToPath } from 'url';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function openFixtures() {
  const baseDir = mkdtempSync(join(tmpdir(), 'sense-test-'));
  cpSync(fixturesDir, baseDir, { recursive: true });
  return open({ presets: { default: { include: ['*.md'], semantic: false } }, queries: {}, baseDir, configPath: null });
}

describe('db', () => {
  it('value mapping: strings and numbers pass through as-is', () => {
    const { db } = openFixtures();
    const row = db.prepare('SELECT title, count FROM frontmatter WHERE path = ?').get('one.md') as Record<string, unknown>;
    assert.equal(row.title, 'Fixture One');
    assert.equal(row.count, 42);
    assert.equal(typeof row.count, 'number');
  });

  it('value mapping: booleans map to 0/1', () => {
    const { db } = openFixtures();
    const row = db.prepare('SELECT active, inactive FROM frontmatter WHERE path = ?').get('one.md') as Record<string, unknown>;
    assert.equal(row.active, 1);
    assert.equal(row.inactive, 0);
  });

  it('value mapping: dates stay as written (plain strings, lexicographically sortable)', () => {
    const { db } = openFixtures();
    const row = db.prepare('SELECT created FROM frontmatter WHERE path = ?').get('one.md') as Record<string, unknown>;
    assert.equal(row.created, '2026-01-15');
  });

  it('value mapping: arrays map to JSON text', () => {
    const { db } = openFixtures();
    const row = db.prepare('SELECT tags FROM frontmatter WHERE path = ?').get('one.md') as Record<string, unknown>;
    assert.equal(row.tags, '["alpha","beta","gamma"]');
  });

  it('missing frontmatter keys map to NULL', () => {
    const { db } = openFixtures();
    const row = db.prepare('SELECT count, active, tags, created FROM frontmatter WHERE path = ?').get('two.md') as Record<string, unknown>;
    assert.equal(row.count, null);
    assert.equal(row.active, null);
    assert.equal(row.tags, null);
    assert.equal(row.created, null);
  });

  it('missing key excludes rows under standard SQL NULL semantics', () => {
    const { db } = openFixtures();
    const rows = db.prepare('SELECT path FROM frontmatter WHERE active = 1').all() as Array<{ path: string }>;
    assert.deepEqual(
      rows.map((r) => r.path),
      ['one.md']
    );
  });

  it('has() on a JSON-array field: membership', () => {
    const { db } = openFixtures();
    const hit = db.prepare('SELECT has(tags, ?) AS r FROM frontmatter WHERE path = ?').get('beta', 'one.md') as { r: number };
    const miss = db.prepare('SELECT has(tags, ?) AS r FROM frontmatter WHERE path = ?').get('zzz', 'one.md') as { r: number };
    assert.equal(hit.r, 1);
    assert.equal(miss.r, 0);
  });

  it('has() on a string field: substring', () => {
    const { db } = openFixtures();
    const hit = db.prepare('SELECT has(description, ?) AS r FROM frontmatter WHERE path = ?').get('needle', 'one.md') as { r: number };
    const miss = db.prepare('SELECT has(description, ?) AS r FROM frontmatter WHERE path = ?').get('absent', 'one.md') as { r: number };
    assert.equal(hit.r, 1);
    assert.equal(miss.r, 0);
  });

  it('has() on NULL (missing key): always false', () => {
    const { db } = openFixtures();
    const row = db.prepare('SELECT has(tags, ?) AS r FROM frontmatter WHERE path = ?').get('alpha', 'two.md') as { r: number };
    assert.equal(row.r, 0);
  });

  it('a frontmatter key literally named `path` is dropped with a warning, real file path wins', () => {
    const result = openFixtures();

    const warned = result.warnings.some((w) => w.includes('three-reserved-path.md') && w.includes('path'));
    assert.ok(warned, 'expected a warning about the reserved `path` frontmatter key');

    const row = result.db.prepare('SELECT path, tags FROM frontmatter WHERE path = ?').get('three-reserved-path.md') as Record<string, unknown>;
    assert.equal(row.path, 'three-reserved-path.md');
    assert.equal(row.tags, '["alpha"]');
  });
});
