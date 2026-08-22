import assert from 'node:assert';
import { openTree, tmpTree, writeNote } from '../lib/tree.ts';

// SQLite rejects spellings ISO 8601 allows, and a rejected date is invisible rather than wrong:
// datetime(d) is NULL, so the row leaves the result set and its negation at once.

// Valid ISO 8601 that SQLite refuses. Punctuation fixes only, so the offset survives.
const NORMALIZED: Array<{ name: string; written: string; instant: string; localDate: string }> = [
  {
    name: 'colonless negative offset (TaskNotes)',
    written: '2026-01-28T10:11:49.617-0800',
    instant: '2026-01-28 18:11:49',
    localDate: '2026-01-28',
  },
  {
    name: 'colonless offset with no fractional seconds',
    written: '2026-01-28T10:11:49-0800',
    instant: '2026-01-28 18:11:49',
    localDate: '2026-01-28',
  },
  {
    name: 'colonless positive offset',
    written: '2026-01-28T10:11:49.617+0530',
    instant: '2026-01-28 04:41:49',
    localDate: '2026-01-28',
  },
  {
    name: 'space instead of T, with a colonless offset',
    written: '2026-01-28 10:11:49-0800',
    instant: '2026-01-28 18:11:49',
    localDate: '2026-01-28',
  },
  {
    name: 'space instead of T, no offset',
    written: '2026-01-28 10:11:49',
    instant: '2026-01-28 10:11:49',
    localDate: '2026-01-28',
  },
];

// Already accepted, so they must survive byte for byte.
const UNTOUCHED = ['2026-01-28T10:11:49.617-08:00', '2026-01-28T10:11:49.617Z', '2026-01-28T10:11:49.617', '2026-01-28', 'not a date at all', 'v1.2-0800'];

// Not a real instant: nothing to normalize to, so they stay as written and stay auditable.
const LEFT_ALONE = ['2026-07-03T06:30:5.512-07:00', '2026-07-18T08:4:00.287-07:00', '2026-13-01T10:11:49-0800', '2026-01-28T25:00:00-0800'];

function storedValue(baseDir: string, path: string): string {
  const { db } = openTree(baseDir);
  const row = db.prepare('SELECT d FROM frontmatter WHERE "path" = ?').get(path) as { d: string };
  db.close();
  return row.d;
}

function datetimeOf(baseDir: string, path: string): string | null {
  const { db } = openTree(baseDir);
  const row = db.prepare(`SELECT datetime(d) AS parsed, substr(d,1,10) AS local FROM frontmatter WHERE "path" = ?`).get(path) as { parsed: string | null; local: string };
  db.close();
  return row.parsed;
}

describe('date normalization: valid ISO 8601 that SQLite rejects', () => {
  for (const { name, written, instant, localDate } of NORMALIZED) {
    it(name, () => {
      const baseDir = tmpTree();
      writeNote(baseDir, 'a.md', { frontmatter: `d: ${written}` });
      const { db } = openTree(baseDir);
      const row = db.prepare(`SELECT d, datetime(d) AS parsed, substr(d,1,10) AS local FROM frontmatter WHERE "path" = 'a.md'`).get() as { d: string; parsed: string | null; local: string };
      db.close();
      assert.equal(row.parsed, instant, `datetime() must parse it (stored as ${JSON.stringify(row.d)})`);
      assert.equal(row.local, localDate, 'the offset is preserved, so substr(d,1,10) is still the local date');
    });
  }

  it('a rejected date is invisible rather than excluded, which is what this prevents', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: 'd: 2026-01-28T10:11:49.617-0800' });
    const { db } = openTree(baseDir);
    const hit = db.prepare(`SELECT COUNT(*) AS n FROM frontmatter WHERE datetime(d) < datetime('2030-01-01')`).get() as { n: number };
    const miss = db.prepare(`SELECT COUNT(*) AS n FROM frontmatter WHERE NOT (datetime(d) < datetime('2030-01-01'))`).get() as { n: number };
    const nulls = db.prepare('SELECT COUNT(*) AS n FROM frontmatter WHERE d IS NULL').get() as { n: number };
    db.close();
    assert.equal(nulls.n, 0, 'the string is present, so an IS NULL guard would never catch it');
    assert.equal(hit.n + miss.n, 1, 'the row must land on one side of the comparison, not vanish from both');
  });
});

describe('date normalization: leaves everything else as written', () => {
  for (const written of UNTOUCHED) {
    it(`keeps ${JSON.stringify(written)} byte for byte`, () => {
      const baseDir = tmpTree();
      writeNote(baseDir, 'a.md', { frontmatter: `d: ${JSON.stringify(written)}` });
      assert.equal(storedValue(baseDir, 'a.md'), written);
    });
  }

  for (const written of LEFT_ALONE) {
    it(`leaves ${JSON.stringify(written)} alone: not a real instant, nothing to normalize to`, () => {
      const baseDir = tmpTree();
      writeNote(baseDir, 'a.md', { frontmatter: `d: ${JSON.stringify(written)}` });
      assert.equal(storedValue(baseDir, 'a.md'), written, 'stored as written');
      assert.equal(datetimeOf(baseDir, 'a.md'), null, 'still unparseable, so the audit query still finds it');
    });
  }

  it('the audit query finds exactly what could not be normalized', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'fixed.md', { frontmatter: 'd: 2026-01-28T10:11:49.617-0800' });
    writeNote(baseDir, 'fine.md', { frontmatter: 'd: 2026-01-28T10:11:49.617-08:00' });
    writeNote(baseDir, 'broken.md', { frontmatter: 'd: "2026-07-03T06:30:5.512-07:00"' });
    const { db } = openTree(baseDir);
    const rows = db.prepare(`SELECT "path" FROM frontmatter WHERE d IS NOT NULL AND datetime(d) IS NULL ORDER BY "path"`).all() as Array<{ path: string }>;
    db.close();
    assert.deepEqual(
      rows.map((r) => r.path),
      ['broken.md']
    );
  });
});
