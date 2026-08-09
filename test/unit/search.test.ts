import assert from 'assert';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { open } from 'sensemaking';

function tmpVault(): string {
  return mkdtempSync(join(tmpdir(), 'sense-search-'));
}

function write(baseDir: string, relPath: string, frontmatter: Record<string, unknown>, content: string): void {
  const lines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  writeFileSync(join(baseDir, relPath), `---\n${lines.join('\n')}\n---\n\n${content}\n`);
}

function openVault(baseDir: string) {
  return open({ scan: { include: ['*.md'] }, queries: {}, baseDir, configPath: null });
}

const WEIGHTED = 'bm25(content, 10.0, 5.0, 1.0)';

describe('search', () => {
  it('matches on body text, not just frontmatter', () => {
    const baseDir = tmpVault();
    write(baseDir, 'a.md', { title: 'A' }, 'The quick brown fox jumps.');
    write(baseDir, 'b.md', { title: 'B' }, 'Nothing relevant lives here.');

    const { db } = openVault(baseDir);
    const rows = db.prepare('SELECT path FROM content WHERE content MATCH ?').all('fox') as Array<{ path: string }>;
    assert.deepEqual(
      rows.map((r) => r.path),
      ['a.md']
    );
  });

  it('joins to frontmatter so a frontmatter filter and a content search compose', () => {
    const baseDir = tmpVault();
    write(baseDir, 'active.md', { status: 'active' }, 'discusses compensation at length');
    write(baseDir, 'archived.md', { status: 'archived' }, 'also discusses compensation at length');

    const { db } = openVault(baseDir);
    const rows = db.prepare(`SELECT d.path FROM frontmatter d JOIN content ON content.path = d.path WHERE d.status = ? AND content MATCH ? ORDER BY ${WEIGHTED}`).all('active', 'compensation') as Array<{ path: string }>;
    assert.deepEqual(
      rows.map((r) => r.path),
      ['active.md']
    );
  });

  it('weighted bm25 ranks a title hit above a body-only mention', () => {
    const baseDir = tmpVault();
    write(baseDir, 'passing.md', { title: 'Something else' }, 'A long note that mentions equity once in passing among many other words.');
    write(baseDir, 'titled.md', { title: 'Equity' }, 'A long note about a different subject entirely, of comparable length overall.');

    const { db } = openVault(baseDir);
    const rows = db.prepare(`SELECT content.path FROM content WHERE content MATCH ? ORDER BY ${WEIGHTED}`).all('equity') as Array<{ path: string }>;
    assert.equal(rows[0].path, 'titled.md');
  });

  it('summary is both a frontmatter column and a ranking field', () => {
    const baseDir = tmpVault();
    write(baseDir, 'a.md', { title: 'A', summary: 'about negotiating offers' }, 'unrelated prose');

    const { db } = openVault(baseDir);
    const row = db.prepare('SELECT summary FROM frontmatter WHERE path = ?').get('a.md') as { summary: string };
    assert.equal(row.summary, 'about negotiating offers');

    const hits = db.prepare('SELECT path FROM content WHERE content MATCH ?').all('summary: offers') as Array<{ path: string }>;
    assert.deepEqual(
      hits.map((r) => r.path),
      ['a.md']
    );
  });

  it('porter stemming matches inflected forms', () => {
    const baseDir = tmpVault();
    write(baseDir, 'a.md', { title: 'A' }, 'Negotiating below the floor is a hard exclusion.');

    const { db } = openVault(baseDir);
    const rows = db.prepare('SELECT path FROM content WHERE content MATCH ?').all('negotiate') as Array<{ path: string }>;
    assert.deepEqual(
      rows.map((r) => r.path),
      ['a.md']
    );
  });

  it('snippets are single-line so they cannot break the table renderer', () => {
    const baseDir = tmpVault();
    write(baseDir, 'a.md', { title: 'A' }, 'First line about widgets.\n\nSecond line.\n\n- a list item\n- another');

    const { db } = openVault(baseDir);
    const row = db.prepare(`SELECT snippet(content, -1, '', '', '…', 20) AS hit FROM content WHERE content MATCH ?`).get('widgets') as { hit: string };
    assert.ok(!row.hit.includes('\n'), `snippet contained a newline: ${JSON.stringify(row.hit)}`);
  });

  it('prose is not reachable from SELECT * on frontmatter', () => {
    const baseDir = tmpVault();
    write(baseDir, 'a.md', { title: 'A' }, 'SECRETLONGBODYTEXT that must not appear in a frontmatter row');

    const { db } = openVault(baseDir);
    const row = db.prepare('SELECT * FROM frontmatter').get() as Record<string, unknown>;
    assert.ok(!JSON.stringify(row).includes('SECRETLONGBODYTEXT'), 'SELECT * FROM frontmatter leaked file content');
  });

  it('a frontmatter key named `content` is dropped with a warning; `body` stays an ordinary column', () => {
    const baseDir = tmpVault();
    write(baseDir, 'a.md', { title: 'A', content: 'should be ignored', body: 'an ordinary value' }, 'prose');

    const result = openVault(baseDir);
    assert.ok(
      result.warnings.some((w) => w.includes('a.md') && w.includes('content')),
      'expected a warning about the reserved `content` frontmatter key'
    );
    const cols = result.db.prepare('PRAGMA table_info(frontmatter)').all() as Array<{ name: string }>;
    assert.ok(!cols.some((c) => c.name === 'content'), '`content` must not become a frontmatter column');
    const row = result.db.prepare('SELECT body FROM frontmatter WHERE path = ?').get('a.md') as { body: string };
    assert.equal(row.body, 'an ordinary value');
  });

  it('markdown syntax is stripped from the index; the text it wrapped is still searchable', () => {
    const baseDir = tmpVault();
    write(baseDir, 'a.md', { title: 'A' }, '# Heading\n\n**Salary** matters, per [[compensation-floor|the floor]].\n\n| Col | Filter |\n|-----|--------|\n| D | `Remote` only |');

    const { db } = openVault(baseDir);
    const { text } = db.prepare('SELECT text FROM content').get() as { text: string };
    for (const noise of ['**', '[[', ']]', '|', '#', '`']) {
      assert.ok(!text.includes(noise), `indexed text still contains "${noise}": ${JSON.stringify(text)}`);
    }
    for (const term of ['floor', 'Remote', 'Salary']) {
      const n = (db.prepare('SELECT count(*) AS n FROM content WHERE content MATCH ?').get(term) as { n: number }).n;
      assert.equal(n, 1, `expected "${term}" to be searchable`);
    }
  });

  it('the canonical query works on a vault with no title or summary keys anywhere', () => {
    const baseDir = tmpVault();
    writeFileSync(join(baseDir, 'bare.md'), '---\n---\n\nProse mentioning gazelles.\n');

    const { db } = openVault(baseDir);
    const rows = db
      .prepare(
        `SELECT d.path, content.title, content.summary, snippet(content, -1, '«', '»', '…', 10) AS hit
         FROM frontmatter d JOIN content ON content.path = d.path
         WHERE content MATCH ? ORDER BY ${WEIGHTED} LIMIT 10`
      )
      .all('gazelles') as Array<{ path: string; title: string; summary: string; hit: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].path, 'bare.md');
    assert.equal(rows[0].title, '');
    assert.equal(rows[0].summary, '');
    assert.ok(rows[0].hit.includes('«gazelles»'));
  });

  it('edits and deletions stay in sync with the search index', () => {
    const baseDir = tmpVault();
    write(baseDir, 'a.md', { title: 'A' }, 'original zebra content');

    const first = openVault(baseDir);
    assert.equal((first.db.prepare('SELECT count(*) AS n FROM content WHERE content MATCH ?').get('zebra') as { n: number }).n, 1);
    first.db.close();

    write(baseDir, 'a.md', { title: 'A' }, 'replaced walrus content entirely, a different length');
    const second = openVault(baseDir);
    assert.equal((second.db.prepare('SELECT count(*) AS n FROM content WHERE content MATCH ?').get('zebra') as { n: number }).n, 0);
    assert.equal((second.db.prepare('SELECT count(*) AS n FROM content WHERE content MATCH ?').get('walrus') as { n: number }).n, 1);
    assert.equal((second.db.prepare('SELECT count(*) AS n FROM content').get() as { n: number }).n, 1);
    second.db.close();

    rmSync(join(baseDir, 'a.md'));
    const third = openVault(baseDir);
    assert.equal((third.db.prepare('SELECT count(*) AS n FROM content').get() as { n: number }).n, 0);
  });

  it('a cache from an older schema is rebuilt rather than left half-empty', () => {
    const baseDir = tmpVault();
    write(baseDir, 'a.md', { title: 'A' }, 'searchable llama content');

    const first = openVault(baseDir);
    first.db.prepare(`UPDATE meta SET value = '0' WHERE key = 'schema_version'`).run();
    first.db.exec('DROP TABLE content');
    first.db.close();

    const second = openVault(baseDir);
    assert.equal(second.parsed, 1);
    assert.equal((second.db.prepare('SELECT count(*) AS n FROM content WHERE content MATCH ?').get('llama') as { n: number }).n, 1);
  });
});
