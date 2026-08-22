import assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { peek } from 'sensemaking';
import { runCli } from '../lib/cli.ts';
import { openTree, tmpTree, writeNote } from '../lib/tree.ts';

// Frontmatter that does not parse is quarantined, not recovered: no columns at all, and
// `_parse_error` carries the reason. One exception, below. See plans/frontmatter-parse-policy.md.
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
