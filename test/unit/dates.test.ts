import assert from 'assert';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { open } from 'sensemaking';

// TaskNotes/Obsidian convention: dateCreated: YYYY-MM-DDTHH:MM:SS.sss±HH:MM.
// Stored as written (yaml core schema has no timestamp type); compared via datetime().

function treeWith(dates: Record<string, string>) {
  const baseDir = mkdtempSync(join(tmpdir(), 'sense-dates-'));
  for (const [name, date] of Object.entries(dates)) {
    writeFileSync(join(baseDir, `${name}.md`), `---\ntitle: ${name}\ndateCreated: ${date}\n---\n\nbody\n`);
  }
  return open({ scan: { include: ['*.md'] }, queries: {}, baseDir, configPath: null });
}

describe('date frontmatter (ISO 8601 with offsets)', () => {
  it('is stored as the literal string written', () => {
    const { db } = treeWith({ a: '2026-08-12T09:15:30.123-07:00' });
    const row = db.prepare('SELECT dateCreated FROM frontmatter').get() as { dateCreated: string };
    assert.equal(row.dateCreated, '2026-08-12T09:15:30.123-07:00');
  });

  it('plain string comparison works when every note shares one offset', () => {
    const { db } = treeWith({
      old: '2026-08-10T08:00:00.000-07:00',
      new: '2026-08-12T09:15:30.123-07:00',
    });
    const rows = db.prepare(`SELECT "path" FROM frontmatter WHERE dateCreated > '2026-08-11' ORDER BY dateCreated`).all() as Array<{ path: string }>;
    assert.deepEqual(
      rows.map((r) => r.path),
      ['new.md']
    );
  });

  it('mixed offsets: plain string order is WRONG, datetime() normalizes to UTC and is right', () => {
    // tokyo is 2026-08-12 01:00 UTC; vancouver is 2026-08-12 16:00 UTC -- tokyo is earlier.
    const { db } = treeWith({
      tokyo: '2026-08-12T10:00:00.000+09:00',
      vancouver: '2026-08-12T09:00:00.000-07:00',
    });
    const byString = db.prepare('SELECT "path" FROM frontmatter ORDER BY dateCreated').all() as Array<{ path: string }>;
    assert.deepEqual(
      byString.map((r) => r.path),
      ['vancouver.md', 'tokyo.md'],
      'string order compares clock time, ignoring offsets'
    );

    const byDatetime = db.prepare('SELECT "path" FROM frontmatter ORDER BY datetime(dateCreated)').all() as Array<{ path: string }>;
    assert.deepEqual(
      byDatetime.map((r) => r.path),
      ['tokyo.md', 'vancouver.md'],
      'datetime() converts offsets to UTC'
    );
  });

  it('datetime() equality holds across representations of the same instant', () => {
    const { db } = treeWith({
      utc: '2026-08-12T16:00:00.000Z',
      offset: '2026-08-12T09:00:00.000-07:00',
    });
    const row = db.prepare(`SELECT COUNT(*) n FROM frontmatter f1, frontmatter f2 WHERE f1."path" < f2."path" AND datetime(f1.dateCreated) = datetime(f2.dateCreated)`).get() as { n: number };
    assert.equal(row.n, 1);
  });

  it('range filters bind as parameters through datetime()', () => {
    const { db } = treeWith({
      a: '2026-08-01T12:00:00.000-07:00',
      b: '2026-08-12T12:00:00.000-07:00',
    });
    const rows = db.prepare(`SELECT "path" FROM frontmatter WHERE datetime(dateCreated) >= datetime(?)`).all('2026-08-05') as Array<{ path: string }>;
    assert.deepEqual(
      rows.map((r) => r.path),
      ['b.md']
    );
  });
});
