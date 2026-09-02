import assert from 'node:assert';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runCli as spawnCli } from '../../../lib/cli.ts';
import { writeModel } from '../../../lib/model.ts';
import { scratchDir } from '../../../lib/scratch.ts';
import { openTree, tmpTree, writeNote } from '../../../lib/tree.ts';

function runCli(dir: string, args: string[]) {
  return spawnCli([...args, '--config', join(dir, 'sense.config.json')]);
}

// The signature's embed segment carries the static model's resolved weight identity (local
// path: size+mtime); an untracked identity adopts silently, a changed identity re-embeds.
describe('embed model identity in the signature', () => {
  function embedTree(modelDir: string): string {
    const dir = scratchDir('embed-sig');
    writeFileSync(join(dir, 'sense.config.json'), JSON.stringify({ version: 5, presets: { default: { include: ['*.md'] } }, embed: { model: modelDir, provider: 'static' }, queries: {} }));
    writeFileSync(join(dir, 'a.md'), '---\ntitle: A\n---\n\napple\n');
    return dir;
  }

  it('adopts a resolved identity that a prior signature never recorded, without a rebuild', () => {
    const model = writeModel();
    const dir = embedTree(model);
    assert.equal(runCli(dir, ['sql', 'SELECT 1']).status, 0);

    const cachePath = join(dir, '.sense', 'cache.db');
    const setup = new DatabaseSync(cachePath);
    // A real (non-NULL) vector, so its survival below actually proves nothing was re-embedded.
    setup.prepare(`UPDATE embeddings SET scale = 1.0, vector = X'2A' WHERE "path" = 'a.md' AND chunk = 0`).run();
    const before = (setup.prepare(`SELECT value FROM meta WHERE key = 'features'`).get() as { value: string }).value;
    assert.match(before, /embed:static:[^|]+@/, 'the fixture is expected to already carry an identity segment');
    // Simulate upgrading from a version that never tracked embed identity.
    setup.prepare(`UPDATE meta SET value = ? WHERE key = 'features'`).run(before.replace(/(embed:static:[^|@]+)@[^|]+/, '$1'));
    setup.close();

    const result = runCli(dir, ['sql', 'SELECT 1']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /recorded the embedding model's resolved identity/);
    assert.ok(!result.stderr.includes('rebuilds the index'), result.stderr);

    const after = new DatabaseSync(cachePath, { readOnly: true });
    const row = after.prepare(`SELECT vector FROM embeddings WHERE "path" = 'a.md' AND chunk = 0`).get() as { vector: Uint8Array } | undefined;
    const features = (after.prepare(`SELECT value FROM meta WHERE key = 'features'`).get() as { value: string }).value;
    after.close();
    assert.ok(row?.vector != null, 'adopting the identity must not clear or re-embed an existing vector');
    assert.equal(features, before, 'meta is restored to the full signature, identity included');
  });

  it('a changed identity (swapped weights) re-embeds through the normal signature-diff rebuild', () => {
    const model = writeModel();
    const dir = embedTree(model);
    assert.equal(runCli(dir, ['sql', 'SELECT 1']).status, 0);

    // Touching the model file's mtime changes its recorded identity (size+mtime) with the
    // config itself untouched -- the swapped-weights case F7 exists for.
    const future = new Date(Date.now() + 5000);
    utimesSync(join(model, 'model.safetensors'), future, future);

    const result = runCli(dir, ['sql', 'SELECT 1']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /config change \(embed settings\) rebuilds the index/);
  });
});

// Plan item 1.1: a preset-only signature change forces a reparse of exactly the files whose
// preset coverage moved, not the whole tree. `file.embed` is a union across presets (scan/list.ts),
// so the case most likely to be wrong is a file two presets cover where only one stops.
describe('preset membership: narrow reparse instead of a full clear', () => {
  // "default" is required by config validation; "extra" is the second preset the trap is about.
  function twoPresetTree(modelDir: string): string {
    const dir = scratchDir('preset-membership');
    writeFileSync(join(dir, 'sense.config.json'), JSON.stringify({ version: 5, presets: { default: { include: ['*.md'] }, extra: { include: ['both.md'] } }, embed: { model: modelDir, provider: 'static' }, queries: {} }));
    writeFileSync(join(dir, 'both.md'), '---\ntitle: Both\n---\n\napple\n'); // covered by default and extra
    writeFileSync(join(dir, 'default-only.md'), '---\ntitle: DefaultOnly\n---\n\napple\n'); // covered by default alone
    return dir;
  }

  function narrowDefault(dir: string, modelDir: string): void {
    writeFileSync(join(dir, 'sense.config.json'), JSON.stringify({ version: 5, presets: { default: { include: ['*.md'], exclude: ['both.md'] }, extra: { include: ['both.md'] } }, embed: { model: modelDir, provider: 'static' }, queries: {} }));
  }

  it('a file two presets cover keeps its vector coverage when only one of them drops it', () => {
    const model = writeModel();
    const dir = twoPresetTree(model);
    assert.equal(runCli(dir, ['sql', 'SELECT 1']).status, 0);

    const cachePath = join(dir, '.sense', 'cache.db');
    const setup = new DatabaseSync(cachePath);
    // Real (non-NULL) vectors on both files, so default-only.md's survival below actually
    // proves nothing was re-embedded, and both.md's is a deliberate sentinel to prove it goes stale.
    setup.prepare(`UPDATE embeddings SET scale = 1.0, vector = X'2A' WHERE "path" = 'default-only.md' AND chunk = 0`).run();
    setup.prepare(`UPDATE embeddings SET scale = 1.0, vector = X'2A' WHERE "path" = 'both.md' AND chunk = 0`).run();
    setup.close();

    narrowDefault(dir, model);
    const result = runCli(dir, ['sql', 'SELECT 1']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /config change \(preset "default"\) reparses only the files it affects/);

    const afterReparse = new DatabaseSync(cachePath, { readOnly: true });
    const defaultOnly = afterReparse.prepare(`SELECT vector FROM embeddings WHERE "path" = 'default-only.md' AND chunk = 0`).get() as { vector: Uint8Array } | undefined;
    const both = afterReparse.prepare(`SELECT * FROM embeddings WHERE "path" = 'both.md'`).all() as Array<{ vector: Uint8Array | null }>;
    const presets = afterReparse.prepare(`SELECT preset FROM preset_files WHERE "path" = 'both.md' ORDER BY preset`).all() as Array<{ preset: string }>;
    afterReparse.close();
    assert.equal(Buffer.from(defaultOnly?.vector as Uint8Array).toString('hex'), '2a', 'default-only.md was never touched by the "default" change, so its vector must be untouched');
    assert.ok(both.length > 0, 'both.md must still have an embeddings row: it is still covered, by "extra"');
    assert.deepEqual(
      presets.map((r) => r.preset),
      ['extra'],
      'both.md drops "default" from its preset_files row but stays present via "extra"'
    );

    // The row went through the normal touched-file path (its "default" membership genuinely
    // moved), so its vector goes pending; a query embeds it, proving it never silently stopped
    // being owed a vector, only that it needed one recomputed. Scoped to "extra": both.md left
    // "default"'s coverage, so that is the preset it is still findable through.
    const search = runCli(dir, ['search', 'apple', '--preset', 'extra', '--format', 'json']);
    assert.equal(search.status, 0, search.stderr);
    const rows = JSON.parse(search.stdout) as Array<{ path: string }>;
    assert.ok(
      rows.some((r) => r.path === 'both.md'),
      JSON.stringify(rows)
    );

    const afterEmbed = new DatabaseSync(cachePath, { readOnly: true });
    const bothVector = afterEmbed.prepare(`SELECT vector FROM embeddings WHERE "path" = 'both.md' AND chunk = 0`).get() as { vector: Uint8Array | null } | undefined;
    afterEmbed.close();
    assert.ok(bothVector?.vector != null, 'both.md must have a real vector again, not be left permanently pending');
  });

  it('a file that loses coverage from every preset is removed through delta.vanished, not left behind', () => {
    const model = writeModel();
    const dir = twoPresetTree(model);
    assert.equal(runCli(dir, ['sql', 'SELECT 1']).status, 0);

    // Drops both.md from every preset (default excludes it, extra is removed): it must fully vanish.
    writeFileSync(join(dir, 'sense.config.json'), JSON.stringify({ version: 5, presets: { default: { include: ['*.md'], exclude: ['both.md'] } }, embed: { model, provider: 'static' }, queries: {} }));
    const result = runCli(dir, ['sql', 'SELECT 1']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /config change \(preset "(default|extra)", preset "(default|extra)"\) reparses only the files it affects/);

    const cachePath = join(dir, '.sense', 'cache.db');
    const after = new DatabaseSync(cachePath, { readOnly: true });
    const frontmatter = after.prepare(`SELECT "path" FROM frontmatter WHERE "path" = 'both.md'`).get();
    const embeddings = after.prepare(`SELECT * FROM embeddings WHERE "path" = 'both.md'`).all();
    const presetFiles = after.prepare(`SELECT * FROM preset_files WHERE "path" = 'both.md'`).all();
    after.close();
    assert.equal(frontmatter, undefined, 'both.md must be gone from frontmatter, not left as a phantom row');
    assert.deepEqual(embeddings, []);
    assert.deepEqual(presetFiles, []);
  });

  it('a file gaining coverage for the first time is parsed like any brand-new file', () => {
    const dir = scratchDir('preset-membership');
    writeFileSync(join(dir, 'sense.config.json'), JSON.stringify({ version: 5, presets: { default: { include: ['default-only/*.md'] } }, queries: {} }));
    mkdirSync(join(dir, 'default-only'), { recursive: true });
    writeFileSync(join(dir, 'default-only', 'a.md'), '---\ntitle: A\n---\n\nbody\n');
    mkdirSync(join(dir, 'extra-only'), { recursive: true });
    writeFileSync(join(dir, 'extra-only', 'newcomer.md'), '---\ntitle: Newcomer\n---\n\nbody\n');
    assert.equal(runCli(dir, ['sql', 'SELECT 1']).status, 0);

    writeFileSync(join(dir, 'sense.config.json'), JSON.stringify({ version: 5, presets: { default: { include: ['default-only/*.md'] }, extra: { include: ['extra-only/*.md'] } }, queries: {} }));
    const result = runCli(dir, ['sql', 'SELECT 1']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /config change \(preset "extra"\) reparses only the files it affects/);

    const cachePath = join(dir, '.sense', 'cache.db');
    const after = new DatabaseSync(cachePath, { readOnly: true });
    const row = after.prepare(`SELECT "path", title FROM frontmatter WHERE "path" = 'extra-only/newcomer.md'`).get() as { path: string; title: string } | undefined;
    const presets = after.prepare(`SELECT preset FROM preset_files WHERE "path" = 'extra-only/newcomer.md'`).all() as Array<{ preset: string }>;
    after.close();
    assert.deepEqual(row, { path: 'extra-only/newcomer.md', title: 'Newcomer' }, 'the newly-covered file must be fully parsed, same as any other new file');
    assert.deepEqual(
      presets.map((r) => r.preset),
      ['extra']
    );
  });

  it('an unrelated preset (not part of the changed set) is entirely untouched: never reparsed, never in the notice', () => {
    const model = writeModel();
    const dir = twoPresetTree(model);
    assert.equal(runCli(dir, ['sql', 'SELECT 1']).status, 0);

    const cachePath = join(dir, '.sense', 'cache.db');
    const setup = new DatabaseSync(cachePath);
    setup.prepare(`UPDATE embeddings SET scale = 1.0, vector = X'2A' WHERE "path" = 'default-only.md' AND chunk = 0`).run();
    setup.close();

    narrowDefault(dir, model);
    const result = runCli(dir, ['sql', 'SELECT 1']);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stderr.includes('preset "extra"'), result.stderr);

    const after = new DatabaseSync(cachePath, { readOnly: true });
    const defaultOnly = after.prepare(`SELECT vector FROM embeddings WHERE "path" = 'default-only.md' AND chunk = 0`).get() as { vector: Uint8Array } | undefined;
    after.close();
    assert.equal(Buffer.from(defaultOnly?.vector as Uint8Array).toString('hex'), '2a');
  });
});

// Plan item 1.1: a feature-toggle-only signature change invalidates only that feature's own
// table. The trap: reconcile.ts's activeFeatures skips a disabled feature's remove/store hooks
// entirely, so its rows rot (orphaned by a deletion, missing for an addition, stale for an edit)
// while it is off -- re-enabling it must fully re-derive from every indexed file, not patch.
describe('feature toggle: narrow reparse instead of a full clear', () => {
  function tagsTree(): string {
    const dir = scratchDir('feature-toggle');
    writeFileSync(join(dir, 'sense.config.json'), JSON.stringify({ version: 5, presets: { default: { include: ['*.md'] } }, queries: {} }));
    writeFileSync(join(dir, 'a.md'), '---\ntitle: A\ntags: ["alpha"]\n---\n\n# Heading A\n\nBody with #beta and a link to [[b]].\n');
    writeFileSync(join(dir, 'b.md'), '---\ntitle: B\ntags: ["gamma"]\n---\n\n# Heading B\n\nBody with #delta.\n');
    return dir;
  }

  function setTagsFeature(dir: string, enabled: boolean): void {
    writeFileSync(join(dir, 'sense.config.json'), JSON.stringify({ version: 5, presets: { default: { include: ['*.md'] } }, features: { tags: enabled }, queries: {} }));
  }

  function tagsRows(dbPath: string): Array<{ path: string; tag: string }> {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('SELECT "path", tag FROM tags ORDER BY "path", tag').all() as Array<{ path: string; tag: string }>;
    db.close();
    return rows;
  }

  function sentinelSections(dbPath: string, value: string): void {
    const db = new DatabaseSync(dbPath);
    db.prepare(`UPDATE sections SET heading = ? WHERE "path" = 'a.md' AND idx = 0`).run(value);
    db.close();
  }

  function readSectionsHeading(dbPath: string): string | undefined {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare(`SELECT heading FROM sections WHERE "path" = 'a.md' AND idx = 0`).get() as { heading: string } | undefined;
    db.close();
    return row?.heading;
  }

  function sentinelLinks(dbPath: string, value: string): void {
    const db = new DatabaseSync(dbPath);
    db.prepare(`UPDATE links SET dst = ? WHERE src = 'a.md' AND target = 'b'`).run(value);
    db.close();
  }

  function readLinksDst(dbPath: string): string | null | undefined {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare(`SELECT dst FROM links WHERE src = 'a.md' AND target = 'b'`).get() as { dst: string | null } | undefined;
    db.close();
    return row?.dst;
  }

  it('tags toggled off empties the tags table and leaves sections/links untouched', () => {
    const dir = tagsTree();
    assert.equal(runCli(dir, ['sql', 'SELECT 1']).status, 0);
    const cachePath = join(dir, '.sense', 'cache.db');
    assert.ok(tagsRows(cachePath).length > 0, 'fixture must actually produce tags to prove the table emptied');

    const SENTINEL_HEADING = 'SENTINEL-HEADING-untouched-off';
    const SENTINEL_DST = 'SENTINEL-DST-untouched-off';
    sentinelSections(cachePath, SENTINEL_HEADING);
    sentinelLinks(cachePath, SENTINEL_DST);

    setTagsFeature(dir, false);
    const result = runCli(dir, ['sql', 'SELECT 1']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /config change \(feature "tags"\) reparses only the feature it affects/);

    assert.deepEqual(tagsRows(cachePath), []);
    assert.equal(readSectionsHeading(cachePath), SENTINEL_HEADING, 'sections must be untouched by a tags-only toggle');
    assert.equal(readLinksDst(cachePath), SENTINEL_DST, 'links must be untouched by a tags-only toggle');
  });

  it('tags toggled back on fully re-derives the tags table for every file, sections/links still untouched', () => {
    const dir = tagsTree();
    assert.equal(runCli(dir, ['sql', 'SELECT 1']).status, 0);
    const cachePath = join(dir, '.sense', 'cache.db');
    const originalTags = tagsRows(cachePath);

    setTagsFeature(dir, false);
    assert.equal(runCli(dir, ['sql', 'SELECT 1']).status, 0);
    assert.deepEqual(tagsRows(cachePath), []);

    const SENTINEL_HEADING = 'SENTINEL-HEADING-untouched-on';
    const SENTINEL_DST = 'SENTINEL-DST-untouched-on';
    sentinelSections(cachePath, SENTINEL_HEADING);
    sentinelLinks(cachePath, SENTINEL_DST);

    setTagsFeature(dir, true);
    const result = runCli(dir, ['sql', 'SELECT 1']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /config change \(feature "tags"\) reparses only the feature it affects/);

    assert.deepEqual(tagsRows(cachePath), originalTags, 'tags must be fully and correctly re-derived for every file');
    assert.equal(readSectionsHeading(cachePath), SENTINEL_HEADING, 'sections must be untouched by a tags-only toggle');
    assert.equal(readLinksDst(cachePath), SENTINEL_DST, 'links must be untouched by a tags-only toggle');
  });

  it('the rot case: a file deleted and another edited while tags is off must not survive re-enable -- the table is fully re-derived, not patched', () => {
    const dir = tagsTree();
    assert.equal(runCli(dir, ['sql', 'SELECT 1']).status, 0);
    const cachePath = join(dir, '.sense', 'cache.db');

    setTagsFeature(dir, false);
    assert.equal(runCli(dir, ['sql', 'SELECT 1']).status, 0);

    // While tags is off: b.md is deleted (its old tags rows would orphan under a patch-based
    // implementation) and a.md is edited to a different tag set (its old rows would go stale).
    rmSync(join(dir, 'b.md'));
    writeFileSync(join(dir, 'a.md'), '---\ntitle: A\ntags: ["alpha-2"]\n---\n\n# Heading A\n\nBody with #epsilon now, no more beta.\n');

    setTagsFeature(dir, true);
    const result = runCli(dir, ['sql', 'SELECT 1']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /config change \(feature "tags"\) reparses only the feature it affects/);

    const actual = tagsRows(cachePath);
    assert.ok(!actual.some((r) => r.path === 'b.md'), 'b.md was deleted while tags was off; a patch-based re-derive would leave its rows behind');
    assert.deepEqual(actual.map((r) => r.tag).sort(), ['alpha-2', 'epsilon']);

    // Oracle: a from-scratch tree with tags on from the start, holding the exact same final
    // file contents. Row equality with it proves re-derivation, not incremental patching.
    const oracleDir = scratchDir('feature-toggle-oracle');
    writeFileSync(join(oracleDir, 'sense.config.json'), JSON.stringify({ version: 5, presets: { default: { include: ['*.md'] } }, queries: {} }));
    writeFileSync(join(oracleDir, 'a.md'), '---\ntitle: A\ntags: ["alpha-2"]\n---\n\n# Heading A\n\nBody with #epsilon now, no more beta.\n');
    assert.equal(runCli(oracleDir, ['sql', 'SELECT 1']).status, 0);
    const expected = tagsRows(join(oracleDir, '.sense', 'cache.db'));

    assert.deepEqual(actual, expected);
  });
});

// Plan item 1.1: rank has no table of its own -- it writes PageRank into frontmatter's own
// `_rank` column -- and a links toggle always co-changes the `feature:rank` segment
// (featureEnabled's dependency), so both are handled together rather than falling through.
describe('feature toggle: rank and links (no table of its own; links co-changes rank)', () => {
  function rankTree(): string {
    const dir = scratchDir('feature-toggle-rank');
    writeFileSync(join(dir, 'sense.config.json'), JSON.stringify({ version: 5, presets: { default: { include: ['*.md'] } }, queries: {} }));
    writeFileSync(join(dir, 'a.md'), '---\ntitle: A\ntags: ["alpha"]\n---\n\n# Heading A\n\nLinks to [[b]].\n');
    writeFileSync(join(dir, 'b.md'), '---\ntitle: B\ntags: ["beta"]\n---\n\n# Heading B\n\nLinks to [[c]].\n');
    writeFileSync(join(dir, 'c.md'), '---\ntitle: C\ntags: ["gamma"]\n---\n\n# Heading C\n\nLinks to [[a]].\n');
    return dir;
  }

  function setFeatures(dir: string, features: Record<string, boolean>): void {
    writeFileSync(join(dir, 'sense.config.json'), JSON.stringify({ version: 5, presets: { default: { include: ['*.md'] } }, features, queries: {} }));
  }

  function rankRows(dbPath: string): Array<{ path: string; _rank: number | null }> {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('SELECT "path", "_rank" FROM frontmatter ORDER BY "path"').all() as Array<{ path: string; _rank: number | null }>;
    db.close();
    return rows;
  }

  function linksRows(dbPath: string): Array<{ src: string; target: string; dst: string | null; embed: number }> {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('SELECT src, target, dst, embed FROM links ORDER BY src, target, embed').all() as Array<{ src: string; target: string; dst: string | null; embed: number }>;
    db.close();
    return rows;
  }

  it('rank toggled off nulls _rank for every row and nothing else', () => {
    const dir = rankTree();
    assert.equal(runCli(dir, ['sql', 'SELECT 1']).status, 0);
    const cachePath = join(dir, '.sense', 'cache.db');
    const beforeRanks = rankRows(cachePath);
    assert.ok(
      beforeRanks.every((r) => typeof r._rank === 'number'),
      'the fixture must have real rank values to prove nulling'
    );
    const beforeLinks = linksRows(cachePath);

    setFeatures(dir, { rank: false });
    const result = runCli(dir, ['sql', 'SELECT 1']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /config change \(feature "rank"\) reparses only the feature it affects/);

    assert.deepEqual(
      rankRows(cachePath).map((r) => r._rank),
      [null, null, null]
    );
    assert.deepEqual(linksRows(cachePath), beforeLinks, 'links must be untouched by a rank-only toggle');
  });

  it('rank toggled back on recomputes _rank to match a from-scratch build, over the unchanged links table', () => {
    const dir = rankTree();
    assert.equal(runCli(dir, ['sql', 'SELECT 1']).status, 0);
    const cachePath = join(dir, '.sense', 'cache.db');

    setFeatures(dir, { rank: false });
    assert.equal(runCli(dir, ['sql', 'SELECT 1']).status, 0);

    setFeatures(dir, {});
    const result = runCli(dir, ['sql', 'SELECT 1']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /config change \(feature "rank"\) reparses only the feature it affects/);

    // Oracle: a from-scratch tree with rank on from the start, holding the same file contents.
    const oracleDir = scratchDir('feature-toggle-rank-oracle-on');
    writeFileSync(join(oracleDir, 'sense.config.json'), JSON.stringify({ version: 5, presets: { default: { include: ['*.md'] } }, queries: {} }));
    writeFileSync(join(oracleDir, 'a.md'), '---\ntitle: A\ntags: ["alpha"]\n---\n\n# Heading A\n\nLinks to [[b]].\n');
    writeFileSync(join(oracleDir, 'b.md'), '---\ntitle: B\ntags: ["beta"]\n---\n\n# Heading B\n\nLinks to [[c]].\n');
    writeFileSync(join(oracleDir, 'c.md'), '---\ntitle: C\ntags: ["gamma"]\n---\n\n# Heading C\n\nLinks to [[a]].\n');
    assert.equal(runCli(oracleDir, ['sql', 'SELECT 1']).status, 0);

    assert.deepEqual(rankRows(cachePath), rankRows(join(oracleDir, '.sense', 'cache.db')));
  });

  it('the rot case: links off then on, with a file deleted and another edited in between -- links and _rank both fully re-derive to match a from-scratch build', () => {
    const dir = rankTree();
    assert.equal(runCli(dir, ['sql', 'SELECT 1']).status, 0);
    const cachePath = join(dir, '.sense', 'cache.db');

    setFeatures(dir, { links: false });
    const off = runCli(dir, ['sql', 'SELECT 1']);
    assert.equal(off.status, 0, off.stderr);
    assert.match(off.stderr, /config change \(feature "links", feature "rank"\) reparses only the feature it affects/);
    assert.deepEqual(linksRows(cachePath), [], 'links must be dropped while off');
    assert.deepEqual(
      rankRows(cachePath).map((r) => r._rank),
      [null, null, null],
      'rank must also null while links is off, since rank depends on links'
    );

    // While links is off: c.md is deleted (its edges must not survive a patch) and b.md is
    // edited to link to a instead of c.
    rmSync(join(dir, 'c.md'));
    writeFileSync(join(dir, 'b.md'), '---\ntitle: B\ntags: ["beta"]\n---\n\n# Heading B\n\nNow links to [[a]].\n');

    setFeatures(dir, {});
    const on = runCli(dir, ['sql', 'SELECT 1']);
    assert.equal(on.status, 0, on.stderr);
    assert.match(on.stderr, /config change \(feature "links", feature "rank"\) reparses only the feature it affects/);

    const actualLinks = linksRows(cachePath);
    const actualRank = rankRows(cachePath);
    assert.ok(!actualLinks.some((r) => r.src === 'c.md' || r.dst === 'c.md'), 'c.md was deleted while links was off; a patch-based re-derive would leave its edges behind');

    // Oracle: a from-scratch tree holding the exact final file contents.
    const oracleDir = scratchDir('feature-toggle-rank-oracle');
    writeFileSync(join(oracleDir, 'sense.config.json'), JSON.stringify({ version: 5, presets: { default: { include: ['*.md'] } }, queries: {} }));
    writeFileSync(join(oracleDir, 'a.md'), '---\ntitle: A\ntags: ["alpha"]\n---\n\n# Heading A\n\nLinks to [[b]].\n');
    writeFileSync(join(oracleDir, 'b.md'), '---\ntitle: B\ntags: ["beta"]\n---\n\n# Heading B\n\nNow links to [[a]].\n');
    assert.equal(runCli(oracleDir, ['sql', 'SELECT 1']).status, 0);
    const oracleCachePath = join(oracleDir, '.sense', 'cache.db');

    assert.deepEqual(actualLinks, linksRows(oracleCachePath));
    assert.deepEqual(actualRank, rankRows(oracleCachePath));
  });
});

// busy_timeout derives from what reconcile has observed itself take, not a constant -- see
// src/store/sqlite/reconcile.ts (meta.reconcile_max_ms) and src/store/sqlite/open.ts (derivation).

describe('derived busy_timeout', () => {
  it('a reconcile that does work records its duration in meta.reconcile_max_ms', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'body' });

    const { store } = await openTree(baseDir);
    const row = (await (await store.prepare(`SELECT value FROM meta WHERE key = 'reconcile_max_ms'`)).get()) as { value: string } | undefined;
    assert.ok(row, 'expected reconcile_max_ms to be recorded after a reconcile that parsed a file');
    assert.ok(Number(row?.value) >= 0);
    await store.close();
  });

  it('a fabricated large reconcile_max_ms makes the next open derive a 3x busy_timeout', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'body' });

    const first = await openTree(baseDir);
    await first.store.close();

    // reopen with nothing changed (fast no-op reconcile, doesn't touch meta itself) and fabricate a huge recorded max
    const probe = await openTree(baseDir);
    const insertMax = await probe.store.prepare(`INSERT INTO meta (key, value) VALUES ('reconcile_max_ms', '50000') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    await insertMax.run();
    await probe.store.close();

    const second = await openTree(baseDir);
    const timeout = ((await (await second.store.prepare('PRAGMA busy_timeout')).get()) as { timeout: number }).timeout;
    assert.equal(timeout, 150000, '3x the fabricated 50000ms max');
    await second.store.close();
  });

  it('one pathological recorded max is capped at 10 minutes, not honoured forever', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'body' });
    const first = await openTree(baseDir);
    await first.store.close();

    const probe = await openTree(baseDir);
    // an 8-minute build would derive 24min; the cap keeps later opens bounded
    const insertMax = await probe.store.prepare(`INSERT INTO meta (key, value) VALUES ('reconcile_max_ms', '480000') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    await insertMax.run();
    await probe.store.close();

    const second = await openTree(baseDir);
    const timeout = ((await (await second.store.prepare('PRAGMA busy_timeout')).get()) as { timeout: number }).timeout;
    assert.equal(timeout, 600000);
    await second.store.close();
  });

  it('a small or absent recorded max stays at the 30s floor', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'body' });

    const { store } = await openTree(baseDir);
    const timeout = ((await (await store.prepare('PRAGMA busy_timeout')).get()) as { timeout: number }).timeout;
    assert.equal(timeout, 30000);
    await store.close();
  });
});
