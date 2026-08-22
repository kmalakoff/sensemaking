import assert from 'node:assert';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache, open, SenseError } from 'sensemaking';

function tmpTree(): string {
  return mkdtempSync(join(tmpdir(), 'sense-reconcile-'));
}

function write(baseDir: string, relPath: string, frontmatter: Record<string, unknown>): void {
  const lines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  writeFileSync(join(baseDir, relPath), `---\n${lines.join('\n')}\n---\n\nbody\n`);
}

function openTree(baseDir: string) {
  return open({ presets: { default: { include: ['*.md'] } }, queries: {}, baseDir, configPath: null });
}

describe('reconcile', () => {
  it('create files -> open -> counts', () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', { title: 'A' });
    write(baseDir, 'b.md', { title: 'B' });

    const result = openTree(baseDir);
    const rows = result.db.prepare('SELECT path FROM frontmatter ORDER BY path').all() as Array<{ path: string }>;
    assert.deepEqual(
      rows.map((r) => r.path),
      ['a.md', 'b.md']
    );
    assert.equal(result.parsed, 2);
  });

  it('unchanged files are not reparsed on a second open', () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', { title: 'A' });

    const first = openTree(baseDir);
    assert.equal(first.parsed, 1);
    first.db.close();

    const second = openTree(baseDir);
    assert.equal(second.parsed, 0, 'warm cache: nothing should be reparsed');
    second.db.close();
  });

  it('modifying a file (mtime/size change) updates its row', () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', { title: 'Original' });

    const first = openTree(baseDir);
    first.db.close();

    // force a distinct mtime; fast successive writes can quantize to the same one
    write(baseDir, 'a.md', { title: 'Updated', extra: 'field' });
    const future = new Date(Date.now() + 5000);
    utimesSync(join(baseDir, 'a.md'), future, future);

    const second = openTree(baseDir);
    assert.equal(second.parsed, 1);
    const row = second.db.prepare('SELECT title, extra FROM frontmatter WHERE path = ?').get('a.md') as Record<string, unknown>;
    assert.equal(row.title, 'Updated');
    assert.equal(row.extra, 'field');
    second.db.close();
  });

  it('deleting a file removes its row', () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', { title: 'A' });
    write(baseDir, 'b.md', { title: 'B' });

    const first = openTree(baseDir);
    first.db.close();

    rmSync(join(baseDir, 'b.md'));

    const second = openTree(baseDir);
    const rows = second.db.prepare('SELECT path FROM frontmatter ORDER BY path').all() as Array<{ path: string }>;
    assert.deepEqual(
      rows.map((r) => r.path),
      ['a.md']
    );
    second.db.close();
  });

  it('adding a file makes its row appear', () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', { title: 'A' });

    const first = openTree(baseDir);
    first.db.close();

    write(baseDir, 'b.md', { title: 'B' });

    const second = openTree(baseDir);
    const rows = second.db.prepare('SELECT path FROM frontmatter ORDER BY path').all() as Array<{ path: string }>;
    assert.deepEqual(
      rows.map((r) => r.path),
      ['a.md', 'b.md']
    );
    assert.equal(second.parsed, 1, 'only the new file should be reparsed');
    second.db.close();
  });

  it('a new frontmatter key adds a column', () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', { title: 'A' });

    const first = openTree(baseDir);
    first.db.close();

    const future = new Date(Date.now() + 5000);
    write(baseDir, 'b.md', { title: 'B', brandNew: 'yes' });
    utimesSync(join(baseDir, 'b.md'), future, future);

    const second = openTree(baseDir);
    const columns = second.db.prepare('PRAGMA table_info(frontmatter)').all() as Array<{ name: string }>;
    assert.ok(columns.some((c) => c.name === 'brandNew'));

    const rowA = second.db.prepare('SELECT brandNew FROM frontmatter WHERE path = ?').get('a.md') as Record<string, unknown>;
    assert.equal(rowA.brandNew, null, 'pre-existing rows get NULL for a newly added column');
    second.db.close();
  });

  it('clearCache: deletes .sense/, so the next open fully re-crawls and drops lingering columns', () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', { title: 'A' });
    write(baseDir, 'gone.md', { title: 'Gone', ephemeral: 'value' });

    const first = openTree(baseDir);
    let columns = first.db.prepare('PRAGMA table_info(frontmatter)').all() as Array<{ name: string }>;
    assert.ok(columns.some((c) => c.name === 'ephemeral'));
    first.db.close();

    rmSync(join(baseDir, 'gone.md'));
    const second = openTree(baseDir);
    // ALTER TABLE ADD COLUMN doesn't undo itself
    columns = second.db.prepare('PRAGMA table_info(frontmatter)').all() as Array<{ name: string }>;
    assert.ok(
      columns.some((c) => c.name === 'ephemeral'),
      'column lingers after the row is deleted'
    );
    second.db.close();

    const cfg = { presets: { default: { include: ['*.md'] } }, queries: {}, baseDir, configPath: null };
    clearCache(cfg);
    const rebuilt = open(cfg);
    columns = rebuilt.db.prepare('PRAGMA table_info(frontmatter)').all() as Array<{ name: string }>;
    assert.ok(!columns.some((c) => c.name === 'ephemeral'), 'a cleared cache re-crawls fresh, dropping the lingering column');
    const count = (rebuilt.db.prepare('SELECT COUNT(*) AS n FROM frontmatter').get() as { n: number }).n;
    assert.equal(count, 1);
    rebuilt.db.close();
  });

  it('re-parsing an existing doc leaves exactly one content row per path, and search finds the updated text', () => {
    const baseDir = tmpTree();
    writeFileSync(join(baseDir, 'a.md'), '---\ntitle: "A"\n---\n\noriginal needle text\n');

    const first = openTree(baseDir);
    first.db.close();

    const future = new Date(Date.now() + 5000);
    writeFileSync(join(baseDir, 'a.md'), '---\ntitle: "A"\n---\n\nupdated haystack text\n');
    utimesSync(join(baseDir, 'a.md'), future, future);

    const second = openTree(baseDir);
    const count = (second.db.prepare('SELECT COUNT(*) AS n FROM content WHERE "path" = ?').get('a.md') as { n: number }).n;
    assert.equal(count, 1, 'exactly one content row per path after a reparse');

    const hit = (second.db.prepare('SELECT COUNT(*) AS n FROM content WHERE content MATCH ?').get('haystack') as { n: number }).n;
    assert.equal(hit, 1);
    const stale = (second.db.prepare('SELECT COUNT(*) AS n FROM content WHERE content MATCH ?').get('needle') as { n: number }).n;
    assert.equal(stale, 0, 'the old text should no longer be indexed');
    second.db.close();
  });

  it("the frontmatter upsert keeps a row's rowid stable across a reparse, so content stays coupled to it", () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', { title: 'A' });

    const first = openTree(baseDir);
    const before = (first.db.prepare('SELECT rowid AS r FROM frontmatter WHERE "path" = ?').get('a.md') as { r: number }).r;
    first.db.close();

    const future = new Date(Date.now() + 5000);
    write(baseDir, 'a.md', { title: 'A2' });
    utimesSync(join(baseDir, 'a.md'), future, future);

    const second = openTree(baseDir);
    const after = (second.db.prepare('SELECT rowid AS r FROM frontmatter WHERE "path" = ?').get('a.md') as { r: number }).r;
    assert.equal(after, before, 'ON CONFLICT UPDATE should not change the rowid the way OR REPLACE would');
    second.db.close();
  });

  it("crossing SQLite's column limit fails with a named error, not the raw SQLite message", () => {
    const baseDir = tmpTree();
    const frontmatter: Record<string, unknown> = {};
    for (let i = 0; i < 2001; i++) frontmatter[`k${i}`] = i;
    write(baseDir, 'huge.md', frontmatter);

    assert.throws(
      () => openTree(baseDir),
      (err: unknown) => {
        assert.ok(err instanceof SenseError, `expected a SenseError, got ${err}`);
        assert.equal((err as SenseError).code, 'COLUMN_LIMIT');
        assert.match((err as Error).message, /2000/);
        assert.match((err as Error).message, /sqlite\.org\/limits\.html/);
        assert.match((err as Error).message, /presets.+include/);
        return true;
      }
    );
  });
});
