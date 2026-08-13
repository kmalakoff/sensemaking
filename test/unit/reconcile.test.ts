import assert from 'assert';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { open, rebuild } from 'sensemaking';

function tmpTree(): string {
  return mkdtempSync(join(tmpdir(), 'sense-reconcile-'));
}

function write(baseDir: string, relPath: string, frontmatter: Record<string, unknown>): void {
  const lines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  writeFileSync(join(baseDir, relPath), `---\n${lines.join('\n')}\n---\n\nbody\n`);
}

function openTree(baseDir: string) {
  return open({ scan: { include: ['*.md'] }, queries: {}, baseDir, configPath: null });
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

  it('rebuild: deletes .sense/ and fully re-crawls, dropping lingering columns', () => {
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

    const rebuilt = rebuild({ scan: { include: ['*.md'] }, queries: {}, baseDir, configPath: null });
    columns = rebuilt.db.prepare('PRAGMA table_info(frontmatter)').all() as Array<{ name: string }>;
    assert.ok(!columns.some((c) => c.name === 'ephemeral'), "rebuild's fresh crawl drops the lingering column");
    const count = (rebuilt.db.prepare('SELECT COUNT(*) AS n FROM frontmatter').get() as { n: number }).n;
    assert.equal(count, 1);
    rebuilt.db.close();
  });
});
