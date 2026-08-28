import assert from 'node:assert';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, peek } from 'sensemaking';
import { runCli } from '../../lib/cli.ts';
import { openTree, tmpTree, writeNote } from '../../lib/tree.ts';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');

function openFixtures() {
  const baseDir = mkdtempSync(join(tmpdir(), 'sense-test-'));
  cpSync(fixturesDir, baseDir, { recursive: true });
  return open({ presets: { default: { include: ['*.md'] } }, queries: {}, baseDir, configPath: null });
}

// Frontmatter that does not parse is quarantined, not recovered: no columns at all, and
// `_parse_error` carries the reason. One exception, below.
//
// These tables are the policy documentation. Nothing here asserts on yaml's internals -- every
// case runs through a real index build and checks our own output -- so a yaml upgrade that
// reclassifies a shape fails as a named policy test rather than as a dependency test.

// Every error is BAD_SCALAR_START: YAML reserves `@` and backtick at the start of a plain
// scalar, so they can never be valid and the recovered text has no second reading. Columns must
// populate and `_parse_error` must stay NULL.
const ACCEPTED: Array<{ name: string; fm: string; expect: Record<string, unknown> }> = [
  {
    name: 'Obsidian alias starting with @, alongside ordinary keys',
    fm: 'title: A\naliases: [@handle, other]\nstatus: active',
    expect: { title: 'A', aliases: '["@handle","other"]', status: 'active' },
  },
  { name: 'bare @ scalar', fm: 'alias: @handle', expect: { alias: '@handle' } },
  { name: '@ as a block sequence item', fm: 'aliases:\n  - @handle\n  - other', expect: { aliases: '["@handle","other"]' } },
  { name: 'backtick, the other reserved start', fm: 'code: `inline`', expect: { code: '`inline`' } },
  { name: '@ mid-value is not an error at all', fm: 'note: hello @handle there', expect: { note: 'hello @handle there' } },
];

// Any other fault: no frontmatter columns, and `_parse_error` naming it. `absorbed` lists keys
// the broken syntax swallowed, which must not surface as columns under any name.
const QUARANTINED: Array<{ name: string; fm: string; absorbed?: string[] }> = [
  { name: 'unquoted colon swallows the keys after it', fm: 'title: Foo: Bar\nstatus: open', absorbed: ['status'] },
  { name: 'unquoted markdown link mangles the value', fm: 'title: [Text](https://example.com/a)\nstatus: open' },
  { name: 'same key twice with differing values', fm: 'status: open\nstatus: done' },
  { name: 'same key twice with identical values', fm: 'category: Task\ncategory: Task' },
  { name: 'bold title opens a YAML alias, materialising throws', fm: 'title: **Bold**' },
  { name: 'one accepted code mixed with one fatal: every error must be accepted, not any', fm: 'aliases: [@handle]\ntitle: Foo: Bar\nstatus: open' },
];

function columnsOf(db: ReturnType<typeof openTree>['db'], path: string): Record<string, unknown> {
  const row = db.prepare('SELECT * FROM frontmatter WHERE "path" = ?').get(path) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith('_') || key === 'path') continue; // internal columns: _mtime, _size, _rank, _parse_error
    if (value !== null) out[key] = value;
  }
  return out;
}

describe('frontmatter parse policy: accepted', () => {
  for (const { name, fm, expect } of ACCEPTED) {
    it(name, () => {
      const baseDir = tmpTree();
      writeNote(baseDir, 'a.md', { frontmatter: fm });
      const { db } = openTree(baseDir);
      const row = db.prepare('SELECT * FROM frontmatter WHERE "path" = ?').get('a.md') as Record<string, unknown>;
      assert.equal(row._parse_error, null, 'accepted parses leave _parse_error NULL');
      assert.deepEqual(columnsOf(db, 'a.md'), expect);
      db.close();
    });
  }
});

describe('frontmatter parse policy: quarantined', () => {
  for (const { name, fm, absorbed } of QUARANTINED) {
    it(name, () => {
      const baseDir = tmpTree();
      writeNote(baseDir, 'a.md', { frontmatter: fm });
      const { db } = openTree(baseDir);
      const row = db.prepare('SELECT * FROM frontmatter WHERE "path" = ?').get('a.md') as Record<string, unknown>;
      assert.equal(typeof row._parse_error, 'string', '_parse_error carries the reason');
      assert.notEqual(row._parse_error, '');
      assert.deepEqual(columnsOf(db, 'a.md'), {}, 'a refused parse writes no frontmatter columns');
      for (const key of absorbed ?? []) {
        assert.ok(!(key in row) || row[key] === null, `${key} was swallowed by the bad syntax and must not surface`);
      }
      db.close();
    });
  }
});

describe('frontmatter parse policy: structure', () => {
  it('a quarantined note keeps its content, links and sections rows and is still searchable', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'broken.md', { frontmatter: 'title: Foo: Bar', body: '# Heading\n\nthe body mentions widgets and [[other]].' });
    writeNote(baseDir, 'other.md', { frontmatter: { title: 'Other' } });
    const { db } = openTree(baseDir);

    const hit = db.prepare(`SELECT path FROM content WHERE content MATCH 'widgets'`).all() as Array<{ path: string }>;
    assert.deepEqual(
      hit.map((r) => r.path),
      ['broken.md'],
      'a broken note stays full-text searchable'
    );
    const links = db.prepare('SELECT dst FROM links WHERE src = ?').all('broken.md') as Array<{ dst: string }>;
    assert.deepEqual(
      links.map((r) => r.dst),
      ['other.md'],
      'and stays in the link graph'
    );
    const sections = db.prepare('SELECT heading FROM sections WHERE "path" = ?').all('broken.md') as Array<{ heading: string }>;
    assert.deepEqual(
      sections.map((r) => r.heading),
      ['Heading']
    );
    db.close();
  });

  it('fixing the file clears _parse_error and populates the columns, with no explicit rebuild', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: 'title: Foo: Bar\nstatus: open' });
    const first = openTree(baseDir);
    assert.equal(typeof (first.db.prepare(`SELECT _parse_error FROM frontmatter WHERE "path" = 'a.md'`).get() as { _parse_error: unknown })._parse_error, 'string');
    first.db.close();

    writeNote(baseDir, 'a.md', { frontmatter: 'title: "Foo: Bar"\nstatus: open' });
    const second = openTree(baseDir);
    const row = second.db.prepare(`SELECT * FROM frontmatter WHERE "path" = 'a.md'`).get() as Record<string, unknown>;
    assert.equal(row._parse_error, null);
    assert.equal(row.title, 'Foo: Bar');
    assert.equal(row.status, 'open');
    second.db.close();
  });

  it('a note with no frontmatter at all is not a parse error', () => {
    const baseDir = tmpTree();
    writeFileSync(join(baseDir, 'plain.md'), '# Just a heading\n\nbody\n');
    const { db } = openTree(baseDir);
    const row = db.prepare(`SELECT _parse_error FROM frontmatter WHERE "path" = 'plain.md'`).get() as { _parse_error: unknown };
    assert.equal(row._parse_error, null);
    db.close();
  });

  it('peek on a quarantined note says the frontmatter did not parse, and names the line', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'broken.md', { frontmatter: 'title: Foo: Bar', body: '# Heading\n\nbody' });
    writeFileSync(join(baseDir, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['**/*.md'] } }, queries: {} }));
    const { db, cfg } = openTree(baseDir);
    const peeked = peek(db, cfg, 'broken.md');
    assert.deepEqual(peeked.frontmatter, {}, 'nothing was recovered, so nothing is shown');
    assert.match(String(peeked.parseError), /line 1, column 8/);
    db.close();

    // And it reaches the reader, not just the Peek object.
    const rendered = runCli(['peek', 'broken.md'], { cwd: baseDir });
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.match(rendered.stdout, /did not parse/);
  });

  it('an unrendered template placeholder parses, and is reported with its path', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'tpl.md', { frontmatter: 'title: Recipe Template\ncreated: {{date}}\nstatus: open' });
    const { db, warnings } = openTree(baseDir);
    // Valid YAML for a flow map used as a key, so no error code can catch it: the row is not
    // quarantined and `created` holds the stringified key. The warning is the whole remedy.
    const row = db.prepare(`SELECT * FROM frontmatter WHERE "path" = 'tpl.md'`).get() as Record<string, unknown>;
    assert.equal(row._parse_error, null);
    assert.equal(row.status, 'open');
    assert.ok(
      warnings.some((w) => w.includes('tpl.md') && w.includes('template placeholder')),
      `expected a path-carrying template warning, got ${JSON.stringify(warnings)}`
    );
    db.close();
  });
});

const write = (baseDir: string, relPath: string, body: string, frontmatter: Record<string, unknown> = {}) => writeNote(baseDir, relPath, { body, frontmatter });

describe('lenient frontmatter', () => {
  // An `@` scalar is accepted, not merely tolerated: YAML reserves the character, so the text
  // can only be what was typed. No warning, no `_parse_error`. Every other fault quarantines --
  // see the ACCEPTED/QUARANTINED tables above for the full table.
  it('an Obsidian-style @ alias parses, with no warning and no parse error', () => {
    const baseDir = tmpTree();
    writeFileSync(join(baseDir, 'handle.md'), '---\naliases:\n- @someone\ntags:\n- \npublish: true\n---\n\nsearchable prose with [[good]]\n');
    write(baseDir, 'good.md', 'fine');

    const result = openTree(baseDir);
    assert.deepEqual(
      result.warnings.filter((w) => w.includes('handle.md')),
      [],
      'a reserved-character scalar is not a fault'
    );
    const row = result.db.prepare('SELECT aliases, publish, "_parse_error" FROM frontmatter WHERE path = ?').get('handle.md') as Record<string, unknown>;
    assert.equal(row._parse_error, null);
    assert.equal(row.aliases, '["@someone"]', 'the @ value survives');
    assert.equal(row.publish, 1);
    assert.equal((result.db.prepare('SELECT COUNT(*) AS n FROM content WHERE content MATCH ?').get('searchable') as { n: number }).n, 1);
    const link = result.db.prepare('SELECT dst FROM links WHERE src = ?').get('handle.md') as { dst: string };
    assert.equal(link.dst, 'good.md');
  });

  it('non-mapping frontmatter is ignored with a warning; the file still indexes', () => {
    const baseDir = tmpTree();
    writeFileSync(join(baseDir, 'scalar.md'), '---\njust a string\n---\n\nprose\n');

    const result = openTree(baseDir);
    assert.ok(
      result.warnings.some((w) => w.includes('scalar.md') && w.includes('not a key-value mapping')),
      `expected warning: ${result.warnings}`
    );
    assert.equal((result.db.prepare('SELECT COUNT(*) AS n FROM frontmatter').get() as { n: number }).n, 1);
  });
});

// TaskNotes/Obsidian convention: dateCreated: YYYY-MM-DDTHH:MM:SS.sss±HH:MM.
// Stored as written (yaml core schema has no timestamp type); compared via datetime().

function treeWith(dates: Record<string, string>) {
  const baseDir = tmpTree();
  for (const [name, date] of Object.entries(dates)) {
    writeNote(baseDir, `${name}.md`, { frontmatter: { title: name, dateCreated: date } });
  }
  return openTree(baseDir);
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
    name: 'hour-only offset',
    written: '2026-01-28T10:11:49.617-08',
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
// The last three are ISO-legal but nothing writing markdown frontmatter emits them, so they are
// deliberately out of scope rather than overlooked.
const LEFT_ALONE = ['2026-07-03T06:30:5.512-07:00', '2026-07-18T08:4:00.287-07:00', '2026-13-01T10:11:49-0800', '2026-01-28T25:00:00-0800', '2026-01-28t10:11:49.617-08:00', '2026-01-28T10:11:49,617-0800', '20260128T101149Z'];

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

  it('warns with the path and the field when a value starts like a date but is not one', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: 'dateModified: "2026-07-03T06:30:5.512-07:00"' });
    const { db, warnings } = openTree(baseDir);
    db.close();
    assert.ok(
      warnings.some((w) => w.includes('a.md') && w.includes('dateModified') && w.includes('2026-07-03T06:30:5.512-07:00')),
      `expected a warning naming the file, the field and the value, got ${JSON.stringify(warnings)}`
    );
  });

  it('does not warn about prose, or about a date it could normalize', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: 'summary: "a note about 2026 budgets"\nd: 2026-01-28T10:11:49.617-0800\ntitle: "not a date at all"' });
    const { db, warnings } = openTree(baseDir);
    db.close();
    assert.deepEqual(warnings, []);
  });

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
