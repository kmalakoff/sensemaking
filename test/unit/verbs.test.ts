import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Row } from 'sensemaking';
import { mapTree, peek, search } from 'sensemaking';
import { resolveNote, scopedPaths } from '../../src/commands.ts';
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

describe('search', () => {
  it('BM25 matches carry via=match with a snippet', async () => {
    const { db, cfg } = openTree(makeTree());
    const rows = (await search(db, cfg, 'price')) as Array<{ path: string; via: string; hit: string }>;
    const floor = rows.find((r) => r.path === 'floor.md');
    assert.ok(floor, `expected floor.md in results: ${JSON.stringify(rows.map((r) => r.path))}`);
    assert.ok(floor.via.includes('match'));
    assert.ok(/«pric/i.test(floor.hit), `no highlighted match in: ${floor.hit}`);
  });

  it('link expansion surfaces a connected note that never contains the terms, via=link', async () => {
    const { db, cfg } = openTree(makeTree());
    const rows = (await search(db, cfg, 'price')) as Array<{ path: string; via: string }>;
    const connected = rows.find((r) => r.path === 'context.md');
    assert.ok(connected, `expected context.md in results: ${JSON.stringify(rows.map((r) => r.path))}`);
    assert.equal(connected.via, 'link');
  });

  it('--where composes a frontmatter filter with the fused ranking', async () => {
    const { db, cfg } = openTree(makeTree());
    const rows = (await search(db, cfg, 'price', { where: "f.status = 'active'" })) as Array<{ path: string }>;
    assert.ok(rows.every((r) => r.path !== 'archived.md'));
    assert.ok(rows.some((r) => r.path === 'floor.md'));
  });

  it('terms pass verbatim: invalid FTS5 syntax errors loudly', async () => {
    const { db, cfg } = openTree(makeTree());
    await assert.rejects(search(db, cfg, 'price AND AND'), /fts5|syntax/);
  });

  it('terms pass verbatim: bare words AND-join, so an absent word means zero rows', async () => {
    const { db, cfg } = openTree(makeTree());
    assert.deepEqual(await search(db, cfg, 'price nonexistentword'), []);
    const rows = (await search(db, cfg, 'price OR nonexistentword')) as Array<{ path: string }>;
    assert.ok(
      rows.some((r) => r.path === 'floor.md'),
      'explicit OR is the caller expressing intent'
    );
  });

  it('with links disabled it degrades to BM25-only', async () => {
    const { db, cfg } = openTree(makeTree(), { links: false });
    const rows = (await search(db, cfg, 'price')) as Array<{ path: string; via: string }>;
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

  it('reports per-preset coverage: files matched and embedded count', () => {
    const baseDir = tmpTree();
    write(baseDir, 'a/one.md', 'alpha content');
    write(baseDir, 'b/two.md', 'beta content');
    const { db, cfg } = openTree(baseDir, undefined, { default: { include: ['**/*.md'] }, a: { include: ['a/**/*.md'] }, b: { include: ['b/**/*.md'] } });
    const result = mapTree(db, cfg);
    const byName = new Map(result.presets.map((p) => [p.name, p]));
    assert.equal(byName.get('default')?.files, 2);
    assert.equal(byName.get('a')?.files, 1);
    assert.equal(byName.get('b')?.files, 1);
    // semantic is off everywhere in this fixture, so nothing is embedded.
    assert.equal(byName.get('a')?.embedded, 0);
  });
});

describe('mapTree scope', () => {
  const mapPresets = { default: { include: ['**/*.md'] }, wiki: { include: ['wiki/**/*.md'] }, raw: { include: ['raw/**/*.md'] } };

  function scopedMapTree(): string {
    const baseDir = tmpTree();
    write(baseDir, 'wiki/hub.md', 'the wiki hub', { title: 'Wiki hub', wikifield: 'x', status: 'active' });
    write(baseDir, 'wiki/spoke.md', 'cites [[hub]]', { title: 'Wiki spoke', wikifield: 'y', status: 'active' });
    write(baseDir, 'raw/core.md', 'the raw core', { title: 'Raw core', rawfield: 'x', status: 'archived' });
    write(baseDir, 'raw/leaf.md', 'cites [[core]]', { title: 'Raw leaf', rawfield: 'y', status: 'archived' });
    return baseDir;
  }

  it('with no scope flags, mapTree scopes to the default preset (broad here, so the whole tree)', () => {
    const { db, cfg } = openTree(scopedMapTree(), undefined, mapPresets);
    const bare = mapTree(db, cfg);
    const explicitEmpty = mapTree(db, cfg, {});
    assert.deepEqual(bare, explicitEmpty);
    assert.equal(bare.docs.count, 4, "the default preset here is '**/*.md', so it covers the whole tree");
    assert.equal(bare.recent.length, 4);
  });

  it('with no scope flags, a narrow default preset scopes bare map to it, not the whole index', () => {
    const narrowDefault = { default: { include: ['wiki/**/*.md'] }, raw: { include: ['raw/**/*.md'] } };
    const { db, cfg } = openTree(scopedMapTree(), undefined, narrowDefault);
    const bare = mapTree(db, cfg);
    assert.equal(bare.docs.count, 2, 'raw notes are indexed by the raw preset but fall outside the default scope');
    assert.ok((bare.recent as Array<{ path: string }>).every((r) => r.path.startsWith('wiki/')));
  });

  it('--preset narrows docs, fields, hubs, and recent to the preset subset', () => {
    const { db, cfg } = openTree(scopedMapTree(), undefined, mapPresets);
    const result = mapTree(db, cfg, { preset: 'wiki' });
    assert.equal(result.docs.count, 2);
    const byField = new Map(result.fields.map((f) => [f.field, f]));
    assert.equal(byField.get('wikifield')?.coverage, 2);
    assert.equal(byField.get('rawfield')?.coverage, 0, 'raw-only field has zero coverage inside the wiki scope');
    assert.ok(
      (result.hubs as Array<{ path: string }>).every((h) => h.path.startsWith('wiki/')),
      `hubs leaked out of scope: ${JSON.stringify(result.hubs)}`
    );
    assert.ok(
      (result.hubs as Array<{ path: string }>).some((h) => h.path === 'wiki/hub.md'),
      'the linked-to wiki note is still a hub within scope'
    );
    assert.equal(result.recent.length, 2);
    assert.ok((result.recent as Array<{ path: string }>).every((r) => r.path.startsWith('wiki/')));
    // Preset coverage and feature states are global config facts, not narrowed by scope.
    assert.ok(result.presets.some((p) => p.name === 'raw'));
  });

  it('--include narrows ad hoc, without naming a preset', () => {
    const { db, cfg } = openTree(scopedMapTree(), undefined, mapPresets);
    const result = mapTree(db, cfg, { include: ['raw/**/*.md'] });
    assert.equal(result.docs.count, 2);
    assert.ok((result.recent as Array<{ path: string }>).every((r) => r.path.startsWith('raw/')));
  });

  it('--exclude narrows ad hoc, without naming a preset', () => {
    const { db, cfg } = openTree(scopedMapTree(), undefined, mapPresets);
    const result = mapTree(db, cfg, { exclude: ['raw/**'] });
    assert.equal(result.docs.count, 2);
    assert.ok((result.recent as Array<{ path: string }>).every((r) => r.path.startsWith('wiki/')));
  });

  it('--where narrows to the matching frontmatter condition', () => {
    const { db, cfg } = openTree(scopedMapTree(), undefined, mapPresets);
    const result = mapTree(db, cfg, { where: "f.status = 'active'" });
    assert.equal(result.docs.count, 2);
    assert.ok((result.recent as Array<{ path: string }>).every((r) => r.path.startsWith('wiki/')));
  });

  it('sense map --preset scopes the CLI output', () => {
    const base = scopedMapTree();
    writeFileSync(join(base, 'sense.config.json'), JSON.stringify({ version: 4, presets: mapPresets, queries: {} }));
    const result = runCli(['map', '--preset', 'wiki', '--format', 'json'], { cwd: base });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as { docs: { count: number }; recent: Array<{ path: string }> };
    assert.equal(parsed.docs.count, 2);
    assert.ok(parsed.recent.every((r) => r.path.startsWith('wiki/')));
  });

  it('sense map with no flags scopes to the default preset (the whole tree here)', () => {
    const base = scopedMapTree();
    writeFileSync(join(base, 'sense.config.json'), JSON.stringify({ version: 4, presets: mapPresets, queries: {} }));
    const result = runCli(['map', '--format', 'json'], { cwd: base });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as { docs: { count: number } };
    assert.equal(parsed.docs.count, 4);
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

describe('resolveNote (shared by peek and path)', () => {
  it('resolves a unique basename, case insensitive and .md stripped', () => {
    const paths = ['dir/Note.md', 'other.md'];
    assert.equal(resolveNote(paths, 'note'), 'dir/Note.md');
    assert.equal(resolveNote(paths, 'NOTE.md'), 'dir/Note.md');
  });

  it('an ambiguous basename throws NOTE_AMBIGUOUS', () => {
    const paths = ['a/dup.md', 'b/dup.md'];
    assert.throws(() => resolveNote(paths, 'dup'), /ambiguous/);
  });

  it('no match throws NOTE_NOT_FOUND', () => {
    assert.throws(() => resolveNote(['a.md'], 'missing'), /no note matches/);
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
    assert.equal(result.stdout.trim(), pkg.version);
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

describe('search --where applies before the candidate cut', () => {
  it('finds a filtered match ranked past the BM25 candidate pool', async () => {
    const baseDir = tmpTree();
    // 40 archived notes with a title hit outrank one active note with a body-only
    // mention; the candidate pool is max(k*3, 30), so a post-filter would return [].
    for (let i = 0; i < 40; i++) write(baseDir, `arch${String(i).padStart(2, '0')}.md`, 'widget specs here', { title: `Widget ${i}`, status: 'archived' });
    write(baseDir, 'live.md', 'A much longer note that mentions a widget once among many other unrelated words about several other topics entirely.', { title: 'Operations', status: 'active' });

    const { db, cfg } = openTree(baseDir);
    const rows = (await search(db, cfg, 'widget', { where: "f.status = 'active'" })) as Array<{ path: string }>;
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
    const rows = (await search(db, cfg, 'gadget', { where: "f.status = 'active'" })) as Array<{ path: string; via: string }>;
    assert.ok(
      rows.some((r) => r.path === 'linked-active.md'),
      `expected linked-active via link: ${JSON.stringify(rows)}`
    );
    assert.ok(!rows.some((r) => r.path === 'linked-archived.md'), 'archived link-derived row must be filtered');
  });
});

describe('search provenance', () => {
  it('linkless tree: via is match only, never link', async () => {
    const base = tmpTree();
    writeNote(base, 'a.md', { body: 'alpha topic content' });
    writeNote(base, 'b.md', { body: 'alpha adjacent content' });
    const { db, cfg } = openTree(base);
    const rows = await search(db, cfg, 'alpha');
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
    const rows = await search(db, cfg, 'alpha');
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
    const { db, cfg } = openTree(base, { rank: false });
    const result = mapTree(db, cfg);
    assert.deepEqual(result.features.on, ['links', 'sections']);
    // embed is not one of the features-block toggles, so it is absent from both lists here;
    // `status` reports it on its own line, with the reason when it is off.
    assert.deepEqual(result.features.off, ['rank']);
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
      () => search(db, cfg, 'end-to-end'),
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
    const rows = await search(db, cfg, 'delivery');
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

describe('search default scope (preset where)', () => {
  it("a preset's where fences search; --where replaces it rather than ANDing", async () => {
    const base = tmpTree();
    writeNote(base, 'note.md', { frontmatter: { type: 'knowledge' }, body: 'alpha subject' });
    writeNote(base, 'raw.md', { frontmatter: { type: 'raw' }, body: 'alpha subject' });
    const cfg = { presets: { default: { include: ['**/*.md'], where: "f.type != 'raw'" } }, queries: {}, baseDir: base, configPath: null };
    const { db } = openConfig(cfg);

    const fenced = await search(db, cfg, 'alpha');
    assert.deepEqual(
      fenced.map((r) => r.path),
      ['note.md'],
      "the preset's where excludes raw"
    );

    const widened = await search(db, cfg, 'alpha', { where: '1=1' });
    assert.equal(widened.length, 2, '--where replaces the preset default, so the tree is reachable');

    const narrowed = await search(db, cfg, 'alpha', { where: "f.type = 'raw'" });
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
      spawnSync(process.execPath, ['-e', `process.stdout.columns=100; require(${JSON.stringify(join(packageRoot, 'dist', 'cjs', 'cli.js'))})(['sql','SELECT f.path, f.summary FROM frontmatter f','--format','${format}'],'sense')`], {
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
      () => search(db, cfg, 'end-to-end delivery', { where: 'f.nosuchfield = 1' }),
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

describe('search error coverage beyond ad-hoc search', () => {
  const matchSql = 'SELECT f.path FROM frontmatter f JOIN content ON content.path = f.path WHERE content MATCH ? LIMIT 5';

  it('a saved query using MATCH gets the same explained error as search', () => {
    const base = tmpTree();
    // "probe", not "search" -- "search" is a reserved verb name, so a saved query can never be named it.
    writeFileSync(join(base, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['**/*.md'] } }, queries: { probe: { sql: matchSql } } }));
    writeNote(base, 'a.md', { body: 'about player-coach roles' });
    const result = runCli(['probe', 'player-coach'], { cwd: base });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /punctuation in `player-coach`/);
    assert.match(result.stderr, /double-quoting/);
  });

  it('ad-hoc sense sql with MATCH gets it too', () => {
    const base = tmpTree();
    writeFileSync(join(base, 'sense.config.json'), JSON.stringify({ version: 2, scan: { include: ['**/*.md'] }, queries: {} }));
    writeNote(base, 'a.md', { body: 'text' });
    const result = runCli(['sql', matchSql, 'player-coach'], { cwd: base });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /punctuation in `player-coach`/);
  });

  it('plain SQL errors pass through without search advice', () => {
    const base = tmpTree();
    writeFileSync(join(base, 'sense.config.json'), JSON.stringify({ version: 2, scan: { include: ['**/*.md'] }, queries: {} }));
    writeNote(base, 'a.md', { body: 'text' });
    const result = runCli(['sql', 'SELECT nosuchcol FROM frontmatter'], { cwd: base });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no such column: nosuchcol/);
    assert.doesNotMatch(result.stderr, /punctuation|double-quoting/);
  });
});

describe('search on oversized docs', () => {
  it('overlapping terms never duplicate document text in the excerpt', async () => {
    const baseDir = tmpTree();
    const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(2000);
    write(baseDir, 'big.md', `${filler}\n\nwe test tests here and testing continues\n\n${filler}`, { title: 'Big' });
    const { db, cfg } = openTree(baseDir);
    // "test" occurs inside "tests"/"testing": overlapping spans must be absorbed, not re-emitted.
    const rows = await search(db, cfg, 'test OR tests', { k: 5 });
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
    const rows = (await search(db, cfg, 'zzxyzzy')) as Array<{ path: string; hit: string | null; lines: string | null }>;
    const big = rows.find((r) => r.path === 'big.md');
    assert.ok(big, `expected big.md in results: ${JSON.stringify(rows.map((r) => r.path))}`);
    assert.ok(big.hit !== null, 'expected a JS-computed excerpt, not null');
    assert.ok(big.hit.includes('«zzxyzzy»'), `expected the marker highlighted: ${big.hit}`);
    assert.match(big.lines as string, /^L\d+-\d+$/, `expected a section-backed lines range: ${big.lines}`);
  });

  it('a via=link row pulled in from the oversized doc still has a null hit', async () => {
    const { db, cfg } = openTree(bigTree());
    const rows = (await search(db, cfg, 'zzxyzzy')) as Array<{ path: string; via: string; hit: string | null }>;
    const other = rows.find((r) => r.path === 'other.md');
    assert.ok(other, `expected other.md via link: ${JSON.stringify(rows.map((r) => r.path))}`);
    assert.equal(other.via, 'link');
    assert.equal(other.hit, null);
  });

  it('a small note in the same tree still gets an ordinary FTS5 snippet', async () => {
    const { db, cfg } = openTree(bigTree());
    const rows = (await search(db, cfg, 'unrelated')) as Array<{ path: string; hit: string | null }>;
    const other = rows.find((r) => r.path === 'other.md');
    assert.ok(other, `expected other.md matched directly: ${JSON.stringify(rows.map((r) => r.path))}`);
    assert.ok(other.hit?.includes('«unrelated»'), `expected an ordinary snippet: ${other.hit}`);
  });

  it('completes well under a second, not the multi-second snippet() cliff', async () => {
    const { db, cfg } = openTree(bigTree());
    const start = Date.now();
    await search(db, cfg, 'zzxyzzy');
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `search took ${elapsed}ms`);
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

// peek's `nearby` (a 2-hop ring) was removed: peek's contract is token cost, and it was
// 21% of the output for a question `search`'s ranked link expansion and the documented
// WITH RECURSIVE recipe already answer.
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

describe('renamed verbs keep one release of a pointer', () => {
  it('sense query exits 2 pointing at sql, not the unknown-entry error', () => {
    const base = makeTree();
    writeFileSync(join(base, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['**/*.md'] } }, queries: {} }));
    const result = runCli(['query', 'SELECT 1'], { cwd: base });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /query is now sql/);
  });

  it('sense find exits 2 with a pointer, not the unknown-entry error', () => {
    const base = tmpTree();
    writeFileSync(join(base, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['**/*.md'] } }, queries: {} }));
    writeNote(base, 'a.md', { body: 'alpha' });
    const result = runCli(['find', 'alpha'], { cwd: base });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /find is now search/);
    assert.match(result.stderr, /usage:/);
  });
});

describe('--preset scope', () => {
  const twoPresets = { default: { include: ['**/*.md'] }, wiki: { include: ['wiki/**/*.md'] }, raw: { include: ['raw/**/*.md'] } };

  function twoPresetTree(): string {
    const baseDir = tmpTree();
    write(baseDir, 'wiki/page.md', 'alpha subject in the wiki', { title: 'Wiki page' });
    write(baseDir, 'raw/source.md', 'alpha subject in raw', { title: 'Raw source' });
    return baseDir;
  }

  it('filters rows to the named preset', async () => {
    const { db, cfg } = openTree(twoPresetTree(), undefined, twoPresets);
    const rows = await search(db, cfg, 'alpha', { preset: 'wiki' });
    assert.deepEqual(
      rows.map((r) => r.path),
      ['wiki/page.md']
    );
    db.close();
  });

  it('an unknown preset throws, listing the declared names', async () => {
    const { db, cfg } = openTree(twoPresetTree(), undefined, twoPresets);
    await assert.rejects(search(db, cfg, 'alpha', { preset: 'nope' }), (err: Error) => {
      assert.match(err.message, /unknown preset "nope"/);
      assert.match(err.message, /wiki/);
      assert.match(err.message, /raw/);
      return true;
    });
    db.close();
  });

  it('with no --preset, the default preset (matching the whole tree here) is searched', async () => {
    const { db, cfg } = openTree(twoPresetTree(), undefined, twoPresets);
    const rows = await search(db, cfg, 'alpha');
    assert.deepEqual(rows.map((r) => r.path).sort(), ['raw/source.md', 'wiki/page.md']);
    db.close();
  });

  it('--include scopes ad hoc, without naming a preset', async () => {
    const { db, cfg } = openTree(twoPresetTree(), undefined, twoPresets);
    const rows = await search(db, cfg, 'alpha', { include: ['raw/**/*.md'] });
    assert.deepEqual(
      rows.map((r) => r.path),
      ['raw/source.md']
    );
    db.close();
  });

  it('--exclude scopes ad hoc, without naming a preset', async () => {
    const { db, cfg } = openTree(twoPresetTree(), undefined, twoPresets);
    const rows = await search(db, cfg, 'alpha', { exclude: ['wiki/**'] });
    assert.deepEqual(
      rows.map((r) => r.path),
      ['raw/source.md']
    );
    db.close();
  });

  it('include and exclude override independently: an ad hoc --include no longer drops the preset exclude', async () => {
    const baseDir = twoPresetTree();
    const presetWithExclude = { default: { include: ['**/*.md'], exclude: ['raw/**'] } };
    const { db, cfg } = openTree(baseDir, undefined, presetWithExclude);
    const rows = await search(db, cfg, 'alpha', { include: ['**/*.md'] });
    assert.deepEqual(
      rows.map((r) => r.path),
      ['wiki/page.md']
    );
    db.close();
  });

  it('--preset at the CLI filters the table', () => {
    const base = twoPresetTree();
    writeFileSync(join(base, 'sense.config.json'), JSON.stringify({ version: 4, presets: twoPresets, queries: {} }));
    const result = runCli(['search', 'alpha', '--preset', 'raw', '--format', 'json'], { cwd: base });
    assert.equal(result.status, 0, result.stderr);
    const rows = JSON.parse(result.stdout) as Array<{ path: string }>;
    assert.deepEqual(
      rows.map((r) => r.path),
      ['raw/source.md']
    );
  });

  it('--include at the CLI is repeatable', () => {
    const base = twoPresetTree();
    writeFileSync(join(base, 'sense.config.json'), JSON.stringify({ version: 4, presets: twoPresets, queries: {} }));
    const result = runCli(['search', 'alpha', '--include', 'wiki/**/*.md', '--include', 'raw/**/*.md', '--format', 'json'], { cwd: base });
    assert.equal(result.status, 0, result.stderr);
    const rows = JSON.parse(result.stdout) as Array<{ path: string }>;
    assert.deepEqual(rows.map((r) => r.path).sort(), ['raw/source.md', 'wiki/page.md']);
  });

  it('--exclude at the CLI narrows an --include scope', () => {
    const base = twoPresetTree();
    writeFileSync(join(base, 'sense.config.json'), JSON.stringify({ version: 4, presets: twoPresets, queries: {} }));
    const result = runCli(['search', 'alpha', '--include', '**/*.md', '--exclude', 'raw/**', '--format', 'json'], { cwd: base });
    assert.equal(result.status, 0, result.stderr);
    const rows = JSON.parse(result.stdout) as Array<{ path: string }>;
    assert.deepEqual(
      rows.map((r) => r.path),
      ['wiki/page.md']
    );
  });

  it('an unknown --preset at the CLI exits 1 naming the declared presets', () => {
    const base = twoPresetTree();
    writeFileSync(join(base, 'sense.config.json'), JSON.stringify({ version: 4, presets: twoPresets, queries: {} }));
    const result = runCli(['search', 'alpha', '--preset', 'nope'], { cwd: base });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown preset "nope"/);
    assert.match(result.stderr, /wiki/);
    assert.match(result.stderr, /raw/);
  });
});

describe('scopedPaths', () => {
  it('resolves the same include/exclude/preset coverage search() does, narrowed further by where', () => {
    const baseDir = tmpTree();
    write(baseDir, 'wiki/page.md', 'alpha subject in the wiki', { status: 'active' });
    write(baseDir, 'wiki/old.md', 'alpha subject too', { status: 'archived' });
    write(baseDir, 'raw/source.md', 'alpha subject in raw', { status: 'active' });
    const { db, cfg } = openTree(baseDir, undefined, { default: { include: ['**/*.md'] } });

    assert.deepEqual([...scopedPaths(db, cfg, {})].sort(), ['raw/source.md', 'wiki/old.md', 'wiki/page.md']);
    assert.deepEqual([...scopedPaths(db, cfg, { include: ['wiki/**/*.md'] })].sort(), ['wiki/old.md', 'wiki/page.md']);
    assert.deepEqual([...scopedPaths(db, cfg, { exclude: ['wiki/**'] })], ['raw/source.md']);
    assert.deepEqual([...scopedPaths(db, cfg, { where: "f.status = 'active'" })].sort(), ['raw/source.md', 'wiki/page.md']);

    db.close();
  });
});

describe('search resolution precedence', () => {
  it('k: flag > saved field > preset > default preset > built-in', async () => {
    const baseDir = tmpTree();
    for (let i = 0; i < 15; i++) write(baseDir, `n${String(i).padStart(2, '0')}.md`, 'alpha content shared by every note');

    // built-in: no preset defines k, no saved field, no flag -> 10
    const builtinDb = openTree(baseDir, undefined, { default: { include: ['**/*.md'] } });
    assert.equal((await search(builtinDb.db, builtinDb.cfg, 'alpha')).length, 10);
    builtinDb.db.close();

    // default preset's own k wins over the built-in
    const presetDb = openTree(baseDir, undefined, { default: { include: ['**/*.md'], k: 3 } });
    assert.equal((await search(presetDb.db, presetDb.cfg, 'alpha')).length, 3);
    presetDb.db.close();

    // a named preset's k wins over the default preset's
    const namedDb = openTree(baseDir, undefined, { default: { include: ['**/*.md'], k: 3 }, big: { include: ['**/*.md'], k: 7 } });
    assert.equal((await search(namedDb.db, namedDb.cfg, 'alpha', { preset: 'big' })).length, 7);
    // a caller override (standing in for a saved field, or a CLI flag) wins outright
    assert.equal((await search(namedDb.db, namedDb.cfg, 'alpha', { preset: 'big', k: 2 })).length, 2);
    namedDb.db.close();
  });

  it('saved search k overrides its preset, and --k overrides the saved search', () => {
    const baseDir = tmpTree();
    for (let i = 0; i < 15; i++) write(baseDir, `n${String(i).padStart(2, '0')}.md`, 'alpha content shared by every note');
    writeFileSync(join(baseDir, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['**/*.md'], k: 3 } }, queries: { hot: { search: 'alpha', k: 6 } } }));

    const saved = runCli(['hot', '--format', 'json'], { cwd: baseDir });
    assert.equal(saved.status, 0, saved.stderr);
    assert.equal(JSON.parse(saved.stdout).length, 6, 'saved k overrides the preset default');

    const flagged = runCli(['hot', '--k', '2', '--format', 'json'], { cwd: baseDir });
    assert.equal(flagged.status, 0, flagged.stderr);
    assert.equal(JSON.parse(flagged.stdout).length, 2, '--k overrides the saved k');
  });
});

// --lexical was removed with the per-preset `semantic` switch: search is search, and a tree
// without an `embed` block simply has fewer signals.
describe('removed flags', () => {
  it('--lexical is no longer a flag: it exits 2 with the usage line rather than being ignored', () => {
    const base = makeTree();
    writeFileSync(join(base, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['**/*.md'] } }, queries: {} }));
    const result = runCli(['search', 'price', '--lexical', '--format', 'json'], { cwd: base });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /usage: /);
  });
});

describe('per-command flag parsing', () => {
  it('a foreign flag exits 2: init does not accept --k', () => {
    const base = tmpTree();
    const result = runCli(['init', '--k', '5'], { cwd: base });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage: sense init/);
  });

  it('a foreign flag exits 2: status does not accept --force', () => {
    const base = makeTree();
    writeFileSync(join(base, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['**/*.md'] } }, queries: {} }));
    const result = runCli(['status', '--force'], { cwd: base });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage: sense status/);
  });

  it('sense map --list rejects --list and exits 2 (map runs its own parser, not the top-level one)', () => {
    const base = makeTree();
    writeFileSync(join(base, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['**/*.md'] } }, queries: {} }));
    const result = runCli(['map', '--list'], { cwd: base });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage: sense map/);
  });

  it('--version and --list are top-level only: sense status --version errors', () => {
    const base = makeTree();
    writeFileSync(join(base, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['**/*.md'] } }, queries: {} }));
    const result = runCli(['status', '--version'], { cwd: base });
    assert.equal(result.status, 2);
  });

  it('sense search -h exits 0 and prints the search usage line', () => {
    const result = runCli(['search', '-h']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /usage: sense search "<terms>"/);
  });

  it('flags before the command word no longer parse', () => {
    const base = makeTree();
    writeFileSync(join(base, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['**/*.md'] } }, queries: {} }));
    const result = runCli(['--format', 'json', 'status'], { cwd: base });
    assert.equal(result.status, 2);
  });

  it('top-level --list still works', () => {
    const base = makeTree();
    writeFileSync(join(base, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['**/*.md'] } }, queries: { hot: { search: 'price' } } }));
    const result = runCli(['--list'], { cwd: base });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /hot\s+\(search\)/);
  });

  it('top-level --version still works', () => {
    const result = runCli(['--version']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^\d+\.\d+\.\d+/);
  });
});

// An omitted string flag has to read as absent, not as an empty string, and a flag passed
// once has to read as a list -- `?? saved.field` and --include depend on those two shapes.
// Both survived a parser swap and back, so each is pinned here rather than assumed.
describe('flag value shapes', () => {
  it('an omitted --k is absent, not an empty string that reads as 0', () => {
    const base = makeTree();
    writeFileSync(join(base, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['**/*.md'] } }, queries: {} }));
    const result = runCli(['search', 'price', '--format', 'json'], { cwd: base });
    assert.equal(result.status, 0, result.stderr);
    assert.ok((JSON.parse(result.stdout) as Row[]).length > 0);
  });

  it("an omitted --where leaves a saved search's own where in force", () => {
    const base = makeTree();
    writeFileSync(join(base, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['**/*.md'] } }, queries: { hot: { search: 'price', where: "status = 'active'" } } }));
    const result = runCli(['hot', '--format', 'json'], { cwd: base });
    assert.equal(result.status, 0, result.stderr);
    const paths = (JSON.parse(result.stdout) as Row[]).map((r) => r.path);
    assert.ok(!paths.includes('archived.md'), `saved where was dropped: ${paths.join(', ')}`);
  });

  it('a single --include still filters as a list', () => {
    const base = makeTree();
    writeFileSync(join(base, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['**/*.md'] } }, queries: {} }));
    const result = runCli(['search', 'price', '--include', 'floor.md', '--format', 'json'], { cwd: base });
    assert.equal(result.status, 0, result.stderr);
    const paths = (JSON.parse(result.stdout) as Row[]).map((r) => r.path);
    assert.deepEqual(paths, ['floor.md']);
  });

  it('--k=-1 is a usage error, and --k -1 is rejected rather than silently defaulted', () => {
    const base = makeTree();
    writeFileSync(join(base, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['**/*.md'] } }, queries: {} }));
    const joined = runCli(['search', 'price', '--k=-1'], { cwd: base });
    assert.equal(joined.status, 2);
    assert.match(joined.stderr, /--k expects a positive integer/);
    // parseArgs calls a dashed value ambiguous rather than guessing: still exit 2, never
    // a silent default.
    const spaced = runCli(['search', 'price', '--k', '-1'], { cwd: base });
    assert.equal(spaced.status, 2);
  });
});

// parse() exits rather than returning, so --help cannot fall through into the command body.
// status is the cheapest command where falling through would be visible.
describe('--help never runs the command', () => {
  it('status --help prints usage and builds no cache', () => {
    const base = makeTree();
    writeFileSync(join(base, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['**/*.md'] } }, queries: {} }));
    const result = runCli(['status', '--help'], { cwd: base });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /usage: sense status/);
    assert.equal(existsSync(join(base, '.sense', 'cache.db')), false, 'status --help built a cache');
  });
});

// --include and --exclude override their own side only, so --no-exclude is the only flag that
// widens. It widens the query scope, not the index -- hence the `all` preset here.
describe('--no-exclude', () => {
  const scopedTree = () => {
    const base = tmpTree();
    writeNote(base, 'notes/keep.md', { body: 'alpha' });
    writeNote(base, 'archive/old.md', { body: 'alpha' });
    writeFileSync(join(base, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['**/*.md'], exclude: ['archive/**'] }, all: { include: ['**/*.md'] } }, queries: {} }));
    return base;
  };

  it('the preset excludes archive by default', () => {
    const rows = JSON.parse(runCli(['search', 'alpha', '--format', 'json'], { cwd: scopedTree() }).stdout) as Array<{ path: string }>;
    assert.deepEqual(
      rows.map((r) => r.path),
      ['notes/keep.md']
    );
  });

  it('--include alone still respects it, so widening needs its own flag', () => {
    const rows = JSON.parse(runCli(['search', 'alpha', '--include', '**/*.md', '--format', 'json'], { cwd: scopedTree() }).stdout) as Array<{ path: string }>;
    assert.deepEqual(
      rows.map((r) => r.path),
      ['notes/keep.md']
    );
  });

  it('--no-exclude drops it for one command', () => {
    const rows = JSON.parse(runCli(['search', 'alpha', '--no-exclude', '--format', 'json'], { cwd: scopedTree() }).stdout) as Array<{ path: string }>;
    assert.deepEqual(rows.map((r) => r.path).sort(), ['archive/old.md', 'notes/keep.md']);
  });

  it('an explicit --exclude alongside --no-exclude is the scope: it says what to leave out', () => {
    const rows = JSON.parse(runCli(['search', 'alpha', '--no-exclude', '--exclude', 'notes/**', '--format', 'json'], { cwd: scopedTree() }).stdout) as Array<{ path: string }>;
    assert.deepEqual(
      rows.map((r) => r.path),
      ['archive/old.md']
    );
  });
});
