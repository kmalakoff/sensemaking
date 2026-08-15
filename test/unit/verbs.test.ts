import assert from 'assert';
import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Row } from 'sensemaking';
import { find, mapTree, peek } from 'sensemaking';
import { renderPeek } from '../../src/output.ts';
import { packageRoot, runCli } from '../lib/cli.ts';
import { openConfig, openTree, tmpTree, writeNote } from '../lib/tree.ts';

const write = (baseDir: string, relPath: string, body: string, frontmatter: Record<string, unknown> = {}) => writeNote(baseDir, relPath, { body, frontmatter });

function makeTree(): string {
  const baseDir = tmpTree();
  write(baseDir, 'floor.md', 'The price floor is 100 credits. See [[context]] for why.', { title: 'Pricing floor', status: 'active' });
  write(baseDir, 'context.md', 'Background that never mentions the c-word or the s-word.', { title: 'Context', status: 'active' });
  write(baseDir, 'archived.md', 'Old price discussion, superseded.', { title: 'Old', status: 'archived' });
  write(baseDir, 'unrelated.md', 'Gardening notes.', { title: 'Gardening', status: 'active' });
  return baseDir;
}

describe('find', () => {
  it('BM25 matches carry via=match with a snippet', async () => {
    const { db, cfg } = openTree(makeTree());
    const rows = (await find(db, cfg, 'price')) as Array<{ path: string; via: string; hit: string }>;
    const floor = rows.find((r) => r.path === 'floor.md');
    assert.ok(floor, `expected floor.md in results: ${JSON.stringify(rows.map((r) => r.path))}`);
    assert.ok(floor.via.includes('match'));
    assert.ok(/«pric/i.test(floor.hit), `no highlighted match in: ${floor.hit}`);
  });

  it('link expansion surfaces a connected note that never contains the terms, via=link', async () => {
    const { db, cfg } = openTree(makeTree());
    const rows = (await find(db, cfg, 'price')) as Array<{ path: string; via: string }>;
    const connected = rows.find((r) => r.path === 'context.md');
    assert.ok(connected, `expected context.md in results: ${JSON.stringify(rows.map((r) => r.path))}`);
    assert.equal(connected.via, 'link');
  });

  it('--where composes a frontmatter filter with the fused ranking', async () => {
    const { db, cfg } = openTree(makeTree());
    const rows = (await find(db, cfg, 'price', { where: "f.status = 'active'" })) as Array<{ path: string }>;
    assert.ok(rows.every((r) => r.path !== 'archived.md'));
    assert.ok(rows.some((r) => r.path === 'floor.md'));
  });

  it('terms pass verbatim: invalid FTS5 syntax errors loudly', async () => {
    const { db, cfg } = openTree(makeTree());
    await assert.rejects(find(db, cfg, 'price AND AND'), /fts5|syntax/);
  });

  it('terms pass verbatim: bare words AND-join, so an absent word means zero rows', async () => {
    const { db, cfg } = openTree(makeTree());
    assert.deepEqual(await find(db, cfg, 'price nonexistentword'), []);
    const rows = (await find(db, cfg, 'price OR nonexistentword')) as Array<{ path: string }>;
    assert.ok(
      rows.some((r) => r.path === 'floor.md'),
      'explicit OR is the caller expressing intent'
    );
  });

  it('with links disabled it degrades to BM25-only', async () => {
    const { db, cfg } = openTree(makeTree(), { links: false });
    const rows = (await find(db, cfg, 'price')) as Array<{ path: string; via: string }>;
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.via === 'match'));
    assert.ok(!rows.some((r) => r.path === 'context.md'));
  });
});

describe('mapTree', () => {
  it('reports counts, field coverage, hubs, and recent', () => {
    const { db, cfg } = openTree(makeTree());
    const result = mapTree(db, cfg);
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
    const { db, cfg } = openTree(makeTree(), { rank: false });
    const result = mapTree(db, cfg);
    assert.deepEqual(result.hubs, []);
    assert.equal(result.docs.count, 4);
  });
});

describe('peek', () => {
  function structured(): string {
    const baseDir = tmpTree();
    write(baseDir, 'note.md', '# Alpha\n\nprose\n\n## Beta\n\nmore [[other]] prose\n', { title: 'Structured', tags: ['x'] });
    write(baseDir, 'other.md', 'links back to [[note]]');
    return baseDir;
  }

  it('returns frontmatter, outline with line ranges, and links both ways', () => {
    const { db, cfg } = openTree(structured());
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
    const { db, cfg } = openTree(structured());
    const result = peek(db, cfg, 'note');
    assert.equal(result.path, 'note.md');
  });

  it('unknown path throws with a message', () => {
    const { db, cfg } = openTree(structured());
    assert.throws(() => peek(db, cfg, 'missing'), /no note matches/);
  });
});

describe('peek stays bounded', () => {
  it('caps link lists at 20 and reports totals', () => {
    const baseDir = tmpTree();
    write(baseDir, 'hub.md', 'the target everyone cites');
    for (let i = 0; i < 30; i++) write(baseDir, `n${String(i).padStart(2, '0')}.md`, 'cites [[hub]]');

    const { db, cfg } = openTree(baseDir);
    const result = peek(db, cfg, 'hub.md');
    assert.equal(result.backlinksTotal, 30);
    assert.equal(result.backlinks.length, 20);
  });
});

describe('--version', () => {
  it('prints the package.json version', () => {
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    const result = runCli(['--version']);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), `v${pkg.version}`);
  });
});

describe('mapTree truncation is reported', () => {
  it('fieldsTotal carries the real count when fields exceed 20', () => {
    const baseDir = tmpTree();
    const fm: Record<string, unknown> = {};
    for (let i = 0; i < 25; i++) fm[`field${String(i).padStart(2, '0')}`] = 'v';
    write(baseDir, 'wide.md', 'body', fm);

    const { db, cfg } = openTree(baseDir);
    const result = mapTree(db, cfg);
    assert.equal(result.fields.length, 20);
    assert.equal(result.fieldsTotal, 25);
  });
});

describe('find --where applies before the candidate cut', () => {
  it('finds a filtered match ranked past the BM25 candidate pool', async () => {
    const baseDir = tmpTree();
    // 40 archived notes with a title hit outrank one active note with a body-only
    // mention; the candidate pool is max(k*3, 30), so a post-filter would return [].
    for (let i = 0; i < 40; i++) write(baseDir, `arch${String(i).padStart(2, '0')}.md`, 'widget specs here', { title: `Widget ${i}`, status: 'archived' });
    write(baseDir, 'live.md', 'A much longer note that mentions a widget once among many other unrelated words about several other topics entirely.', { title: 'Operations', status: 'active' });

    const { db, cfg } = openTree(baseDir);
    const rows = (await find(db, cfg, 'widget', { where: "f.status = 'active'" })) as Array<{ path: string }>;
    assert.deepEqual(
      rows.map((r) => r.path),
      ['live.md']
    );
  });

  it('link-derived rows still respect the filter', async () => {
    const baseDir = tmpTree();
    write(baseDir, 'hit.md', 'gadget details, see [[linked-archived]] and [[linked-active]]', { title: 'Gadget', status: 'active' });
    write(baseDir, 'linked-archived.md', 'no matching terms here', { title: 'Old', status: 'archived' });
    write(baseDir, 'linked-active.md', 'no matching terms here either', { title: 'Ref', status: 'active' });

    const { db, cfg } = openTree(baseDir);
    const rows = (await find(db, cfg, 'gadget', { where: "f.status = 'active'" })) as Array<{ path: string; via: string }>;
    assert.ok(
      rows.some((r) => r.path === 'linked-active.md'),
      `expected linked-active via link: ${JSON.stringify(rows)}`
    );
    assert.ok(!rows.some((r) => r.path === 'linked-archived.md'), 'archived link-derived row must be filtered');
  });
});

describe('find provenance', () => {
  it('linkless tree: via is match only, never link', async () => {
    const base = tmpTree();
    writeNote(base, 'a.md', { body: 'alpha topic content' });
    writeNote(base, 'b.md', { body: 'alpha adjacent content' });
    const { db, cfg } = openTree(base);
    const rows = await find(db, cfg, 'alpha');
    assert.ok(rows.length >= 2);
    for (const row of rows) assert.equal(row.via, 'match', `expected match, got ${row.via} for ${row.path}`);
    db.close();
  });

  it('linked tree: a seed with no incident edge stays via match', async () => {
    const base = tmpTree();
    writeNote(base, 'hub.md', { body: 'alpha hub, see [[spoke]]' });
    writeNote(base, 'spoke.md', { body: 'spoke detail' });
    writeNote(base, 'island.md', { body: 'alpha island, no links at all' });
    const { db, cfg } = openTree(base);
    const rows = await find(db, cfg, 'alpha');
    const island = rows.find((r) => r.path === 'island.md');
    assert.ok(island, 'island matched');
    assert.equal(island.via, 'match');
    db.close();
  });
});

describe('feature visibility', () => {
  it('map reports feature states; disabled features carry their config key', () => {
    const base = tmpTree();
    writeNote(base, 'a.md', { body: 'alpha' });
    const { db, cfg } = openTree(base, { rank: false, embed: false });
    const result = mapTree(db, cfg);
    assert.deepEqual(result.features.on, ['links', 'sections']);
    assert.deepEqual(result.features.off, ['rank', 'embed']);
    db.close();
  });

  it('peek distinguishes off from empty: sections off is reported, not silent', () => {
    const base = tmpTree();
    writeNote(base, 'a.md', { body: '# Heading\n\nalpha' });
    const { db, cfg } = openTree(base, { sections: false });
    const result = peek(db, cfg, 'a.md');
    assert.deepEqual(result.sections, []);
    assert.ok(result.off.includes('sections'));
    db.close();
  });
});

describe('field-report fixes', () => {
  it('FTS5 punctuation error names the offending term, not a word inside it', async () => {
    const base = tmpTree();
    writeNote(base, 'a.md', { body: 'body about end-to-end delivery' });
    const { db, cfg } = openTree(base);
    await assert.rejects(
      () => find(db, cfg, 'end-to-end'),
      (err: Error) => {
        assert.match(err.message, /end-to-end/, 'names the term the user typed');
        assert.match(err.message, /double-quot/i, 'states the remedy');
        return true;
      }
    );
    db.close();
  });

  it('a valid query still returns rows (the error path is not over-eager)', async () => {
    const base = tmpTree();
    writeNote(base, 'a.md', { body: 'body about delivery' });
    const { db, cfg } = openTree(base);
    const rows = await find(db, cfg, 'delivery');
    assert.equal(rows.length, 1);
    db.close();
  });

  it('map reports the observed type per field, including drift across notes', () => {
    const base = tmpTree();
    writeNote(base, 'a.md', { frontmatter: { flag: true, count: 3, ratio: 1.5, name: 'x' } });
    writeNote(base, 'b.md', { frontmatter: { count: 'notanumber' } });
    const { db, cfg } = openTree(base);
    const byField = new Map(mapTree(db, cfg).fields.map((f) => [f.field, f.type]));
    assert.equal(byField.get('flag'), 'integer', 'YAML booleans store as INTEGER, so WHERE flag = 1 matches');
    assert.equal(byField.get('ratio'), 'real');
    assert.equal(byField.get('name'), 'text');
    assert.equal(byField.get('count'), 'integer,text', 'a field with mixed types shows both');
    db.close();
  });
});

describe('find default scope', () => {
  it('config default fences find; --where replaces it rather than ANDing', async () => {
    const base = tmpTree();
    writeNote(base, 'note.md', { frontmatter: { type: 'knowledge' }, body: 'alpha subject' });
    writeNote(base, 'raw.md', { frontmatter: { type: 'raw' }, body: 'alpha subject' });
    const cfg = { scan: { include: ['**/*.md'] }, queries: {}, defaults: { find: { where: "f.type != 'raw'" } }, baseDir: base, configPath: null };
    const { db } = openConfig(cfg);

    const fenced = await find(db, cfg, 'alpha');
    assert.deepEqual(
      fenced.map((r) => r.path),
      ['note.md'],
      'default scope excludes raw'
    );

    const widened = await find(db, cfg, 'alpha', { where: '1=1' });
    assert.equal(widened.length, 2, '--where replaces the default, so the tree is reachable');

    const narrowed = await find(db, cfg, 'alpha', { where: "f.type = 'raw'" });
    assert.deepEqual(
      narrowed.map((r) => r.path),
      ['raw.md'],
      'an explicit scope wins outright'
    );
    db.close();
  });
});

describe('table output', () => {
  it('fits the terminal width instead of wrapping; json is never truncated', () => {
    const base = tmpTree();
    writeFileSync(join(base, 'sense.config.json'), JSON.stringify({ version: 2, scan: { include: ['**/*.md'] }, queries: {} }));
    writeNote(base, 'a.md', { frontmatter: { summary: 'x'.repeat(400) }, body: 'body' });
    const run = (format: string) =>
      spawnSync(process.execPath, ['-e', `process.stdout.columns=100; require(${JSON.stringify(join(packageRoot, 'dist', 'cjs', 'cli.js'))})(['query','SELECT f.path, f.summary FROM frontmatter f','--format','${format}'],'sense')`], {
        cwd: base,
        encoding: 'utf8',
      });
    const table = run('table');
    assert.equal(table.status, 0, table.stderr);
    for (const line of table.stdout.split('\n')) assert.ok([...line].length <= 100, `line of ${[...line].length} chars exceeds the declared width`);
    assert.match(table.stdout, /…/, 'truncation is marked');
    const json = run('json');
    assert.match(json.stdout, /x{400}/, 'json keeps full values');
  });
});

describe('search error attribution', () => {
  it('a --where column typo is not blamed on term punctuation', async () => {
    const base = tmpTree();
    writeNote(base, 'a.md', { body: 'body about end-to-end delivery' });
    const { db, cfg } = openTree(base);
    await assert.rejects(
      () => find(db, cfg, 'end-to-end delivery', { where: 'f.nosuchfield = 1' }),
      (err: Error) => {
        assert.doesNotMatch(err.message, /punctuation/, 'the term is innocent here');
        assert.match(err.message, /where condition/, 'the where clause is named instead');
        assert.match(err.message, /pragma_table_info/);
        return true;
      }
    );
    db.close();
  });
});

describe('search error coverage beyond find', () => {
  const matchSql = 'SELECT f.path FROM frontmatter f JOIN content ON content.path = f.path WHERE content MATCH ? LIMIT 5';

  it('a saved query using MATCH gets the same explained error as find', () => {
    const base = tmpTree();
    writeFileSync(join(base, 'sense.config.json'), JSON.stringify({ version: 2, scan: { include: ['**/*.md'] }, queries: { search: matchSql } }));
    writeNote(base, 'a.md', { body: 'about player-coach roles' });
    const result = runCli(['search', 'player-coach'], { cwd: base });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /punctuation in `player-coach`/);
    assert.match(result.stderr, /double-quoting/);
  });

  it('ad-hoc sense query with MATCH gets it too', () => {
    const base = tmpTree();
    writeFileSync(join(base, 'sense.config.json'), JSON.stringify({ version: 2, scan: { include: ['**/*.md'] }, queries: {} }));
    writeNote(base, 'a.md', { body: 'text' });
    const result = runCli(['query', matchSql, 'player-coach'], { cwd: base });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /punctuation in `player-coach`/);
  });

  it('plain SQL errors pass through without search advice', () => {
    const base = tmpTree();
    writeFileSync(join(base, 'sense.config.json'), JSON.stringify({ version: 2, scan: { include: ['**/*.md'] }, queries: {} }));
    writeNote(base, 'a.md', { body: 'text' });
    const result = runCli(['query', 'SELECT nosuchcol FROM frontmatter'], { cwd: base });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no such column: nosuchcol/);
    assert.doesNotMatch(result.stderr, /punctuation|double-quoting/);
  });
});

describe('find on oversized docs', () => {
  it('overlapping terms never duplicate document text in the excerpt', async () => {
    const baseDir = tmpTree();
    const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(2000);
    write(baseDir, 'big.md', `${filler}\n\nwe test tests here and testing continues\n\n${filler}`, { title: 'Big' });
    const { db, cfg } = openTree(baseDir);
    // "test" occurs inside "tests"/"testing": overlapping spans must be absorbed, not re-emitted.
    const rows = await find(db, cfg, 'test OR tests', { k: 5 });
    const hit = rows.find((r) => r.path === 'big.md')?.hit as string;
    assert.ok(hit.includes('«test»'), hit);
    assert.ok(!/»«/.test(hit), `adjacent re-emitted spans in: ${hit}`);
    assert.ok(hit.includes('«tests»'), `longest span should win the tie: ${hit}`);
    const stripped = hit.replace(/[«»…]/g, '');
    assert.ok(stripped.includes('test tests here'), `document text distorted: ${hit}`);
    db.close();
  });

  // Body well past SNIPPET_BOUND so FTS5 snippet() gets CASE-bounded out;
  // the marker sits deep in a second block so a first-160-chars fallback would miss it.
  function bigTree(): string {
    const baseDir = tmpTree();
    const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(2000);
    const body = `# Intro\n\n${filler}\n\n## Deep section\n\nHere is the marker zzxyzzy, see [[other]] for context.\n\n${filler}`;
    write(baseDir, 'big.md', body, { title: 'Big note' });
    write(baseDir, 'other.md', 'unrelated content, no marker here', { title: 'Other' });
    return baseDir;
  }

  it('computes a JS excerpt with the term highlighted and a section-backed lines range', async () => {
    const { db, cfg } = openTree(bigTree());
    const rows = (await find(db, cfg, 'zzxyzzy')) as Array<{ path: string; hit: string | null; lines: string | null }>;
    const big = rows.find((r) => r.path === 'big.md');
    assert.ok(big, `expected big.md in results: ${JSON.stringify(rows.map((r) => r.path))}`);
    assert.ok(big.hit !== null, 'expected a JS-computed excerpt, not null');
    assert.ok(big.hit.includes('«zzxyzzy»'), `expected the marker highlighted: ${big.hit}`);
    assert.match(big.lines as string, /^L\d+-\d+$/, `expected a section-backed lines range: ${big.lines}`);
  });

  it('a via=link row pulled in from the oversized doc still has a null hit', async () => {
    const { db, cfg } = openTree(bigTree());
    const rows = (await find(db, cfg, 'zzxyzzy')) as Array<{ path: string; via: string; hit: string | null }>;
    const other = rows.find((r) => r.path === 'other.md');
    assert.ok(other, `expected other.md via link: ${JSON.stringify(rows.map((r) => r.path))}`);
    assert.equal(other.via, 'link');
    assert.equal(other.hit, null);
  });

  it('a small note in the same tree still gets an ordinary FTS5 snippet', async () => {
    const { db, cfg } = openTree(bigTree());
    const rows = (await find(db, cfg, 'unrelated')) as Array<{ path: string; hit: string | null }>;
    const other = rows.find((r) => r.path === 'other.md');
    assert.ok(other, `expected other.md matched directly: ${JSON.stringify(rows.map((r) => r.path))}`);
    assert.ok(other.hit?.includes('«unrelated»'), `expected an ordinary snippet: ${other.hit}`);
  });

  it('completes well under a second, not the multi-second snippet() cliff', async () => {
    const { db, cfg } = openTree(bigTree());
    const start = Date.now();
    await find(db, cfg, 'zzxyzzy');
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `find took ${elapsed}ms`);
  });
});

describe('mapTree many fields', () => {
  it('aggregates coverage and type across ~40 fields in one scan, matching the old per-column semantics', () => {
    const baseDir = tmpTree();
    const fm: Record<string, unknown> = {};
    for (let i = 0; i < 39; i++) fm[`field${String(i).padStart(2, '0')}`] = i % 2 === 0 ? i : `v${i}`;
    fm.field00 = 5; // numeric in a.md; b.md below redrifts it to text
    write(baseDir, 'a.md', 'body', fm);
    write(baseDir, 'b.md', 'body', { field00: 'drifted' });

    const { db, cfg } = openTree(baseDir);
    const result = mapTree(db, cfg);
    assert.equal(result.fieldsTotal, 39);

    const field00 = result.fields.find((f) => f.field === 'field00');
    assert.ok(field00, 'field00 has the highest coverage and must be in the top 20');
    assert.equal(field00.coverage, 2);
    assert.equal(field00.type, 'integer,text', 'drift across notes shows both observed types');

    const field01 = result.fields.find((f) => f.field === 'field01');
    assert.ok(field01, 'field01 expected in the top 20 (tied coverage, earlier column)');
    assert.equal(field01.coverage, 1);
    assert.equal(field01.type, 'text');
  });
});

describe('peek stays bounded (sections)', () => {
  function headingsTree(n: number): string {
    const baseDir = tmpTree();
    let body = '';
    for (let i = 0; i < n; i++) body += `## Heading ${i}\n\ntext for heading ${i}\n\n`;
    write(baseDir, 'wide.md', body, { title: 'Wide' });
    return baseDir;
  }

  it('caps the outline at 20 and reports the true total', () => {
    const { db, cfg } = openTree(headingsTree(30));
    const result = peek(db, cfg, 'wide.md');
    assert.equal(result.sections.length, 20);
    assert.equal(result.sectionsTotal, 30);
  });

  it('renderPeek prints a +N more line for the truncated outline', () => {
    const { db, cfg } = openTree(headingsTree(30));
    const result = peek(db, cfg, 'wide.md');
    assert.match(renderPeek(result), /\(\+10 more sections -- sections table has all of them\)/);
  });

  it('outbound links are capped with a correct total alongside the outline cap', () => {
    const baseDir = tmpTree();
    let body = '';
    for (let i = 0; i < 30; i++) {
      const name = `t${String(i).padStart(2, '0')}`;
      write(baseDir, `${name}.md`, 'target note');
      body += `see [[${name}]]\n`;
    }
    write(baseDir, 'hub.md', body, { title: 'Hub' });

    const { db, cfg } = openTree(baseDir);
    const result = peek(db, cfg, 'hub.md');
    assert.equal(result.outbound.length, 20);
    assert.equal(result.outboundTotal, 30);
  });
});
