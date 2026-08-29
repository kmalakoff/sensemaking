import assert from 'node:assert';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'http';
import type { Config } from 'sensemaking';
import { peek, presetCoverage, type SenseError, search } from 'sensemaking';
import { relatedNotes } from '../../src/commands/index.ts';
import { languageDistribution } from '../../src/embed/distribution.ts';
import { similarNotes } from '../../src/embed/query.ts';
import { downloadModel, hasModelFiles, isDownloadable, modelDir } from '../../src/embed/store.ts';
import type { Chunk } from '../../src/features/embed.ts';
import { embed } from '../../src/features/embed.ts';
import { parseFile } from '../../src/scan/index.ts';
import { runCli } from '../lib/cli.ts';
import { seedModelCache, writeModel } from '../lib/model.ts';
import { listen } from '../lib/server.ts';
import { chineseTree, openConfig, tmpTree, writeNote } from '../lib/tree.ts';

function fruitTree(): string {
  const baseDir = tmpTree();
  writeNote(baseDir, 'a.md', { frontmatter: { title: 'Fruit' }, body: 'An apple every day' });
  writeNote(baseDir, 'b.md', { frontmatter: { title: 'Walls' }, body: 'stone walls' });
  return baseDir;
}

// linked.md and backlinker.md are apple-similar AND linked, so a naive list surfaces them and
// related must not. similar.md is apple-similar and unlinked: the case related is for.
function relatedTree(): string {
  const baseDir = tmpTree();
  writeNote(baseDir, 'target.md', { frontmatter: { title: 'Target' }, body: 'An apple every day. See [[linked]].' });
  writeNote(baseDir, 'linked.md', { frontmatter: { title: 'Linked' }, body: 'An apple every day.' });
  writeNote(baseDir, 'backlinker.md', { frontmatter: { title: 'Backlinker' }, body: 'An apple every day. See [[target]].' });
  writeNote(baseDir, 'similar.md', { frontmatter: { title: 'Similar' }, body: 'pomme reference here.' });
  writeNote(baseDir, 'unrelated.md', { frontmatter: { title: 'Unrelated' }, body: 'stone walls only.' });
  return baseDir;
}

// Vectors are on for a tree exactly when its config names a model, so these tests point the
// `embed` block at the local Model2Vec fixture above and never touch the network.
function openSemantic(baseDir: string, embed: Config['embed']) {
  return openConfig({ presets: { default: { include: ['**/*.md'] } }, embed, queries: {}, baseDir, configPath: null });
}

// Nothing downloads implicitly. search has
// two other signals to fall back on and says so; related has none and must say why.
describe('missing model', () => {
  it('sense download is idempotent: an already-present model reports that and exits 0', () => {
    const baseDir = fruitTree();
    writeFileSync(join(baseDir, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['**/*.md'] } }, embed: { model: writeModel(), provider: 'static' }, queries: {} }));
    for (const pass of ['first', 'second']) {
      const result = runCli(['download'], { cwd: baseDir });
      assert.equal(result.status, 0, `${pass}: ${result.stderr}`);
      assert.match(result.stdout, /already available/, pass);
    }
  });

  it('search fails rather than silently dropping to two signals: the same query must not answer differently before and after a download', async () => {
    const { db, cfg } = openSemantic(fruitTree(), { model: '/nonexistent/model-xyz', provider: 'static' });
    await assert.rejects(() => search(db, cfg, 'apple'), /searches with vectors, but the local model path .* is missing/);
    db.close();
  });

  it('a preset that does not ask for vectors is unaffected by a missing model', async () => {
    const { db, cfg } = openConfig({
      presets: { default: { include: ['**/*.md'], signals: { words: 1, links: 1 } } },
      embed: { model: '/nonexistent/model-xyz', provider: 'static' },
      queries: {},
      baseDir: fruitTree(),
      configPath: null,
    });
    const rows = (await search(db, cfg, 'apple')) as Array<{ via: string }>;
    db.close();
    assert.ok(rows.length > 0, 'lexical rows still come back');
    assert.ok(!rows.some((r) => r.via.includes('vector')), JSON.stringify(rows));
  });
});

describe('embed feature', () => {
  it('semantic expansion surfaces a note FTS5 cannot reach, labeled via=vector with a lines range', async () => {
    const { db, cfg } = openSemantic(fruitTree(), { model: writeModel(), provider: 'static' });
    const rows = (await search(db, cfg, 'pomme')) as Array<{ path: string; via: string; lines: string }>;
    db.close();
    const hit = rows[0];
    assert.equal(hit.path, 'a.md', JSON.stringify(rows));
    assert.equal(hit.via, 'vector'); // zero FTS matches for 'pomme'
    assert.match(hit.lines, /^L\d+-\d+$/);
  });

  it('a term both matched and vector-near composes via=match+vector', async () => {
    const { db, cfg } = openSemantic(fruitTree(), { model: writeModel(), provider: 'static' });
    const rows = (await search(db, cfg, 'apple')) as Array<{ path: string; via: string }>;
    db.close();
    assert.equal(rows[0].path, 'a.md');
    // link expansion re-includes match seeds, so the full composition is match+link+vector
    assert.match(rows[0].via, /^match\+.*vector$/);
  });

  it('a tree with no embed block searches on words and links only, and carries no similarity column', async () => {
    const { db, cfg } = openConfig({ presets: { default: { include: ['**/*.md'] } }, queries: {}, baseDir: fruitTree(), configPath: null });
    const rows = (await search(db, cfg, 'apple OR stone')) as Array<{ via: string; similarity?: number }>;
    db.close();
    assert.ok(rows.length > 0, JSON.stringify(rows));
    assert.ok(!rows.some((r) => r.via.includes('vector')), JSON.stringify(rows));
    assert.ok(!rows.some((r) => 'similarity' in r), JSON.stringify(rows));
  });

  it('a tree with no embed block answers an unmatched word with zero rows, not an error', async () => {
    const { db, cfg } = openConfig({ presets: { default: { include: ['**/*.md'] } }, queries: {}, baseDir: fruitTree(), configPath: null });
    const rows = (await search(db, cfg, 'pomme')) as Array<{ path: string; via: string }>;
    db.close();
    // 'pomme' has no lexical match anywhere in the fixture and the tree has no vectors, so
    // this is simply zero rows. Fewer signals is not an error.
    assert.deepEqual(rows, []);
  });
});

describe('declared signals', () => {
  it('signals: {"words":1} carries no vector rows and no similarity column, even with a model configured', async () => {
    const { db, cfg } = openConfig({
      presets: { default: { include: ['**/*.md'], signals: { words: 1 } } },
      embed: { model: writeModel(), provider: 'static' },
      queries: {},
      baseDir: fruitTree(),
      configPath: null,
    });
    const rows = (await search(db, cfg, 'apple')) as Array<{ via: string; similarity?: number }>;
    // 'pomme' is only reachable through the vector this preset declined; dropping "vectors"
    // must answer it the same as a tree with no embed block at all: zero rows.
    const zero = await search(db, cfg, 'pomme');
    db.close();
    assert.ok(rows.length > 0, JSON.stringify(rows));
    assert.ok(!rows.some((r) => r.via.includes('vector')), JSON.stringify(rows));
    assert.ok(!rows.some((r) => 'similarity' in r), JSON.stringify(rows));
    assert.deepEqual(zero, []);
  });

  it('signals: {"words":1,"vectors":1} without "links" skips link expansion', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'floor.md', { frontmatter: { title: 'Floor' }, body: 'The price floor is set. See [[context]] for background.' });
    writeNote(baseDir, 'context.md', { frontmatter: { title: 'Context' }, body: 'Nothing about pricing here.' });
    const { db, cfg } = openConfig({
      presets: { default: { include: ['**/*.md'], signals: { words: 1, vectors: 1 } } },
      embed: { model: writeModel(), provider: 'static' },
      queries: {},
      baseDir,
      configPath: null,
    });
    const rows = (await search(db, cfg, 'price')) as Array<{ path: string; via: string }>;
    db.close();
    assert.ok(
      rows.some((r) => r.path === 'floor.md' && r.via.includes('match')),
      JSON.stringify(rows)
    );
    // context.md may still surface through the declared vectors signal (nearest-neighbour
    // search always returns a neighbour); it must never carry via=link, since link expansion
    // was never declared.
    assert.ok(!rows.some((r) => r.via.includes('link')), JSON.stringify(rows));
  });

  it("a signal weight scales its RRF contribution: doubling the vectors weight doubles a vector-only row's score", async () => {
    const withWeight = async (vectorsWeight: number) => {
      const { db, cfg } = openConfig({
        presets: { default: { include: ['**/*.md'], signals: { words: 1, vectors: vectorsWeight } } },
        embed: { model: writeModel(), provider: 'static' },
        queries: {},
        baseDir: fruitTree(),
        configPath: null,
      });
      // 'pomme' has zero lexical matches in the fixture, so every row here is via=vector only,
      // scored at exactly weight / (RRF_K + rank) with no other signal's contribution folded in.
      const rows = (await search(db, cfg, 'pomme')) as Array<{ via: string; score: number }>;
      db.close();
      return rows;
    };
    const weight1 = await withWeight(1);
    const weight2 = await withWeight(2);
    assert.ok(weight1.length > 0 && weight1.every((r) => r.via === 'vector'), JSON.stringify(weight1));
    assert.equal(weight2.length, weight1.length);
    // Each side rounds independently to 4 decimals (round(score, 4) in the SQL), so compare
    // with a tolerance wider than that rounding rather than expecting exact equality.
    weight1.forEach((r, i) => {
      assert.ok(Math.abs(weight2[i].score - r.score * 2) < 0.001, `weight1=${r.score} weight2=${weight2[i].score}`);
    });
  });
});

describe('embed api type', () => {
  let server: Server;
  let url: string;

  before(async () => {
    // Minimal OpenAI-compatible /embeddings endpoint: apple/pomme collapse to one
    // direction, everything else to another.
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        const { input } = JSON.parse(body) as { input: string[] };
        const data = input.map((text) => ({ embedding: /apple|pomme/i.test(text) ? [1, 0, 0, 0] : [0, 1, 0, 0] }));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data }));
      });
    });
    url = `${await listen(server)}/v1`;
  });

  after(() => server.close());

  it('expands through an OpenAI-compatible endpoint', async () => {
    const { db, cfg } = openSemantic(fruitTree(), { model: 'test-model', provider: 'openai', url });
    const rows = (await search(db, cfg, 'pomme')) as Array<{ path: string; via: string }>;
    db.close();
    assert.equal(rows[0].path, 'a.md', JSON.stringify(rows));
    assert.equal(rows[0].via, 'vector');
  });
});

describe('semantic absence signal', () => {
  it('vector rows carry cosine similarity: a real match runs high, absent vocabulary near zero', async () => {
    const { db, cfg } = openSemantic(fruitTree(), { model: writeModel(), provider: 'static' });

    // The lexical baseline is a second tree with no embed block: vectors are all-or-nothing
    // per tree now, so there is no per-call opt-out to compare against.
    const lexical = openConfig({ presets: { default: { include: ['**/*.md'] } }, queries: {}, baseDir: fruitTree(), configPath: null });
    const absent = await search(lexical.db, lexical.cfg, 'zzznotaword');
    lexical.db.close();
    assert.equal(absent.length, 0, 'lexical search answers absence with zero rows');

    const semantic = (await search(db, cfg, 'zzznotaword')) as Array<{ via: string; similarity: number }>;
    assert.ok(semantic.length > 0, 'nearest-neighbour search always returns a neighbour');
    for (const row of semantic) {
      assert.equal(row.via, 'vector');
      assert.ok(Math.abs(row.similarity) < 0.05, `unknown vocabulary embeds to ~zero, got ${row.similarity}`);
    }

    const real = (await search(db, cfg, 'pomme')) as Array<{ path: string; similarity: number }>;
    assert.ok(real[0].similarity > 0.9, `apple ≡ pomme in the fixture, got ${real[0].similarity}`);
    db.close();
  });
});

describe('chunking covers the body, not the raw file', () => {
  it('the first chunk starts at the first body line, so no chunk is the frontmatter block', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A', status: 'open' }, body: '# Heading\n\nprose about orchards' });
    const { db } = openSemantic(baseDir, { model: writeModel(), provider: 'static' });
    const chunks = db.prepare('SELECT chunk, start_line, end_line FROM embeddings WHERE "path" = ? ORDER BY chunk').all('a.md') as Array<{ chunk: number; start_line: number; end_line: number }>;
    // sections is 1-indexed over the raw file, so agreeing with it is the whole invariant:
    // both must point at the same heading line for a range to be a direct Read range.
    const heading = db.prepare('SELECT start_line FROM sections WHERE "path" = ? AND idx = 0').get('a.md') as { start_line: number };
    db.close();
    assert.equal(chunks.length, 1, `frontmatter must not become a chunk of its own: ${JSON.stringify(chunks)}`);
    assert.equal(chunks[0].start_line, heading.start_line, 'the chunk starts where sections says the heading is, not at line 1');
  });

  it('a frontmatter-only note has no chunks at all', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'stub.md', { frontmatter: { title: 'Stub', type: 'project' }, body: '' });
    const { db } = openSemantic(baseDir, { model: writeModel(), provider: 'static' });
    const n = (db.prepare('SELECT COUNT(*) AS n FROM embeddings WHERE "path" = ?').get('stub.md') as { n: number }).n;
    db.close();
    assert.equal(n, 0, 'an empty body embeds to nothing, rather than to a vector of its own YAML');
  });

  // W0 finding: ~29% of hub-corpus blocks become YAML noise if chunk() ever sees the raw file
  // instead of the frontmatter-stripped body. List-valued keys are the case that spans several
  // raw lines, so a wrong offset would put a chunk extent, or its text, inside the YAML block.
  it('list-valued frontmatter (aliases, tags) never leaks into chunk text, and extents map to real body lines', () => {
    const baseDir = tmpTree();
    const fm = 'title: A\naliases:\n  - Alpha\n  - A1\ntags:\n  - x\n  - y';
    writeNote(baseDir, 'a.md', { frontmatter: fm, body: '# Heading\n\nprose about orchards' });
    const absPath = join(baseDir, 'a.md');
    const rawLines = readFileSync(absPath, 'utf8').split('\n');

    const { doc } = parseFile({ relPath: 'a.md', absPath, mtimeMs: 0, ctimeMs: 0, size: 0, presets: [], embed: true }, [embed]);
    const chunks = doc.extracted.embed as Chunk[];

    assert.ok(chunks.length > 0, 'expected at least one chunk');
    for (const c of chunks) {
      assert.equal(c.text.includes('aliases'), false, c.text);
      assert.equal(c.text.includes('tags'), false, c.text);
      assert.equal(c.text.includes('---'), false, c.text);
      // The offset shifts body-relative lines back onto the raw file, so this must be a direct
      // Read range over real content, never a line inside the YAML block.
      assert.equal(rawLines[c.startLine - 1].trim(), '# Heading', `chunk should start at the raw heading line, got: ${JSON.stringify(rawLines[c.startLine - 1])}`);
    }
  });

  // W3b: embed.chunkTokens overrides workingSize under the shipped pgc policy, so pairs that
  // fit under the 500-token default no longer fit under a 100-token owner lever.
  it('embed.chunkTokens produces more, smaller chunks than the 500-token default for the same body', () => {
    const baseDir = tmpTree();
    const paragraph = Array.from({ length: 150 }, () => 'word').join(' '); // ~187 estimated tokens
    const body = Array.from({ length: 8 }, () => paragraph).join('\n\n');
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' }, body });
    const absPath = join(baseDir, 'a.md');
    const file = { relPath: 'a.md', absPath, mtimeMs: 0, ctimeMs: 0, size: 0, presets: [], embed: true };

    const defaultCfg = { presets: {}, queries: {}, embed: { model: 'm' } } as Config;
    const smallCfg = { presets: {}, queries: {}, embed: { model: 'm', chunkTokens: 100 } } as Config;
    const defaultChunks = parseFile(file, [embed], defaultCfg).doc.extracted.embed as Chunk[];
    const smallChunks = parseFile(file, [embed], smallCfg).doc.extracted.embed as Chunk[];

    assert.ok(smallChunks.length > defaultChunks.length, `expected more chunks under chunkTokens:100 (${smallChunks.length} vs ${defaultChunks.length} default)`);
    const maxLen = (chunks: Chunk[]) => Math.max(...chunks.map((c) => c.text.length));
    assert.ok(maxLen(smallChunks) < maxLen(defaultChunks), `expected smaller chunks under chunkTokens:100, got ${maxLen(smallChunks)} vs default ${maxLen(defaultChunks)}`);
  });
});

describe('similarity is a cosine, so it is bounded', () => {
  it('two notes with identical text score exactly 1, not 1.001', async () => {
    const baseDir = tmpTree();
    const body = '# Orchard\n\napple orchard prose that both notes share exactly';
    writeNote(baseDir, 'one.md', { frontmatter: { title: 'One' }, body });
    writeNote(baseDir, 'two.md', { frontmatter: { title: 'One' }, body });
    const { db, cfg } = openSemantic(baseDir, { model: writeModel(), provider: 'static' });
    const rows = await relatedNotes(db, cfg, 'one.md', {}, 5);
    db.close();
    // int8 storage dequantises a little either side of the true cosine; clamping keeps the
    // column a number a reader can reason about.
    assert.equal(rows[0].path, 'two.md');
    assert.equal(rows[0].similarity, 1, `identical text must not exceed 1, got ${rows[0].similarity}`);
  });
});

describe('similarity provenance', () => {
  it('a multi-chunk note reports the best chunk: its similarity and its line range agree', async () => {
    const base = tmpTree();
    // Chunk 1 (heading "Walls"): vector-far from the query. Chunk 2 ("Orchard"): vector-identical.
    writeNote(base, 'two.md', { body: '# Walls\n\nstone walls here\n\n# Orchard\n\nAn apple every day\n' });
    const { db, cfg } = openSemantic(base, { model: writeModel(), provider: 'static' });
    const rows = (await search(db, cfg, 'pomme')) as Array<{ path: string; similarity: number; lines: string }>;
    db.close();
    const hit = rows.find((r) => r.path === 'two.md');
    assert.ok(hit, JSON.stringify(rows));
    assert.ok(hit.similarity > 0.9, `best chunk is the orchard section, got ${hit.similarity}`);
    const [start] = hit.lines.replace('L', '').split('-').map(Number);
    assert.ok(start >= 5, `lines should point at the orchard chunk, got ${hit.lines}`);
  });
});

describe('vector coverage', () => {
  it('every indexed file gets embedding rows when the config names a model: vectors are per-tree, not per-preset', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a/one.md', { frontmatter: { title: 'Fruit' }, body: 'An apple every day' });
    writeNote(baseDir, 'b/two.md', { frontmatter: { title: 'Walls' }, body: 'stone walls' });

    const { db } = openConfig({
      presets: { default: { include: ['**/*.md'] }, a: { include: ['a/**/*.md'] }, b: { include: ['b/**/*.md'] } },
      embed: { model: writeModel(), provider: 'static' },
      queries: {},
      baseDir,
      configPath: null,
    });

    const rows = db.prepare('SELECT DISTINCT "path" FROM embeddings ORDER BY "path"').all() as Array<{ path: string }>;
    assert.deepEqual(
      rows.map((r) => r.path),
      ['a/one.md', 'b/two.md']
    );

    const coverage = db.prepare('SELECT preset, path FROM preset_files ORDER BY preset, path').all() as Array<{ preset: string; path: string }>;
    assert.deepEqual(coverage, [
      { preset: 'a', path: 'a/one.md' },
      { preset: 'b', path: 'b/two.md' },
      { preset: 'default', path: 'a/one.md' },
      { preset: 'default', path: 'b/two.md' },
    ]);
    db.close();
  });

  it('per-preset coverage counts real vectors, not the NULL placeholder rows reconcile writes', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a/one.md', { frontmatter: { title: 'Fruit' }, body: 'An apple every day' });

    const cfgObj = {
      presets: { default: { include: ['**/*.md'] } },
      embed: { model: writeModel(), provider: 'static' as const },
      queries: {},
      baseDir,
      configPath: null,
    };
    const { db, cfg } = openConfig(cfgObj);
    // Vectors are lazy: rows exist with vector NULL until the first search that uses them.
    // Coverage saying "1 embedded" here contradicted status's own "0 embedded, 1 pending" line.
    const before = presetCoverage(db, cfg);
    assert.deepEqual(before, [{ name: 'default', files: 1, embedded: 0, signals: { words: 1, links: 1, vectors: 1 } }]);
    db.close();
  });
});

describe('related command', () => {
  it('surfaces a semantically similar note that is not linked, excluding self/outbound/backlinks', async () => {
    const { db, cfg } = openSemantic(relatedTree(), { model: writeModel(), provider: 'static' });
    // Sanity-check the fixture's link shape (what related must exclude).
    const peeked = peek(db, cfg, 'target.md');
    assert.deepEqual(peeked.outbound, ['linked.md']);
    assert.deepEqual(peeked.backlinks, ['backlinker.md']);
    const result = await relatedNotes(db, cfg, 'target.md', {}, 5);
    db.close();
    const paths = result.map((r) => r.path);
    assert.ok(paths.includes('similar.md'), JSON.stringify(result));
    assert.ok(!paths.includes('linked.md'), JSON.stringify(result));
    assert.ok(!paths.includes('backlinker.md'), JSON.stringify(result));
    assert.ok(!paths.includes('target.md'), JSON.stringify(result));
    const similar = result.find((r) => r.path === 'similar.md');
    assert.ok(similar && similar.similarity > 0.9, `apple ≡ pomme in the fixture, got ${JSON.stringify(result)}`);
  });

  it('respects scope: a --where that drops a candidate keeps it out of related', async () => {
    const { db, cfg } = openSemantic(relatedTree(), { model: writeModel(), provider: 'static' });
    await search(db, cfg, 'apple');
    const result = await relatedNotes(db, cfg, 'target.md', { where: `f."path" != 'similar.md'` }, 5);
    db.close();
    assert.ok(!result.map((r) => r.path).includes('similar.md'), JSON.stringify(result));
  });

  it('excludes every backlink, including those past the old display cap (>20)', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'target.md', { frontmatter: { title: 'Target' }, body: 'An apple every day.' });
    // 22 apple-similar backlinkers. peek's backlinks display truncates at 20; related's
    // exclude set is built from the full, untruncated links table, so none of the 22 leaks in.
    for (let i = 0; i < 22; i++) writeNote(baseDir, `back${String(i).padStart(2, '0')}.md`, { frontmatter: { title: `Back ${i}` }, body: 'An apple every day. See [[target]].' });
    const { db, cfg } = openSemantic(baseDir, { model: writeModel(), provider: 'static' });
    await search(db, cfg, 'apple');
    const peeked = peek(db, cfg, 'target.md');
    assert.equal(peeked.backlinksTotal, 22);
    assert.equal(peeked.backlinks.length, 20, 'peek display list is truncated; related must not inherit that truncation');
    const result = await relatedNotes(db, cfg, 'target.md', {}, 5);
    db.close();
    assert.deepEqual(result, [], `every apple-similar note here is a backlink, so related must be empty: ${JSON.stringify(result)}`);
  });

  // Vectors are related's only signal, so every way of not having them names itself. An empty
  // table is then unambiguous: nothing near in meaning that this note does not already link to.
  it('errors when the tree names no embedding model, rather than answering []', async () => {
    const { db, cfg } = openConfig({ presets: { default: { include: ['**/*.md'] } }, queries: {}, baseDir: relatedTree(), configPath: null });
    await assert.rejects(() => relatedNotes(db, cfg, 'target.md', {}, 5), /no embedding model/);
    db.close();
  });

  it("errors on a preset without the vectors signal instead of borrowing another preset's vectors", async () => {
    const baseDir = relatedTree();
    const { db, cfg } = openConfig({
      presets: { default: { include: ['**/*.md'] }, lex: { include: ['**/*.md'], signals: { words: 1, links: 1 } } },
      queries: {},
      embed: { model: writeModel(), provider: 'static' },
      baseDir,
      configPath: null,
    });
    // The files are embedded, via the overlapping vectors-on preset. Reading the signals is
    // what stops those vectors answering for a scope that declined them.
    await assert.rejects(() => relatedNotes(db, cfg, 'target.md', { preset: 'lex' }, 5), /no "vectors" signal/);
    db.close();
  });

  it('errors when the seed note has no indexed text, rather than answering []', async () => {
    const baseDir = relatedTree();
    writeNote(baseDir, 'stub.md', { frontmatter: { title: 'Stub' }, body: '' });
    const { db, cfg } = openSemantic(baseDir, { model: writeModel(), provider: 'static' });
    await assert.rejects(() => relatedNotes(db, cfg, 'stub.md', {}, 5), /no indexed text/);
    db.close();
  });

  it('computes the lazy vectors itself, so a fresh index answers without a prior semantic search', async () => {
    const { db, cfg } = openSemantic(relatedTree(), { model: writeModel(), provider: 'static' });
    const result = await relatedNotes(db, cfg, 'target.md', {}, 5);
    db.close();
    assert.ok(result.map((r) => r.path).includes('similar.md'), JSON.stringify(result));
  });

  it('says the model is missing rather than answering []: an empty table reads as "nothing is related"', async () => {
    const { db, cfg } = openSemantic(relatedTree(), { model: '/nonexistent/model-xyz', provider: 'static' });
    await assert.rejects(() => relatedNotes(db, cfg, 'target.md', {}, 5), /local model path .* is missing/);
    db.close();
  });
});

describe('similarNotes (unit)', () => {
  it('ranks by cosine, honoring exclude and self-exclusion', async () => {
    const { db, cfg } = openSemantic(relatedTree(), { model: writeModel(), provider: 'static' });
    await search(db, cfg, 'apple'); // warm the lazy vectors, see peek related tests above
    const result = similarNotes(db, cfg, 'target.md', { exclude: new Set(['linked.md', 'backlinker.md']), k: 5 });
    db.close();
    assert.deepEqual(
      result.map((r) => r.path),
      ['similar.md', 'unrelated.md']
    );
    assert.ok(result[0].similarity > result[1].similarity, JSON.stringify(result));
  });

  it('honors an allowed set (scope)', async () => {
    const { db, cfg } = openSemantic(relatedTree(), { model: writeModel(), provider: 'static' });
    await search(db, cfg, 'apple');
    const result = similarNotes(db, cfg, 'target.md', { exclude: new Set(['linked.md', 'backlinker.md']), allowed: new Set(['similar.md']), k: 5 });
    db.close();
    assert.deepEqual(
      result.map((r) => r.path),
      ['similar.md']
    );
  });

  it('returns [] when the target note has no stored vectors, even though the embeddings table exists', () => {
    // default covers everything but opts target.md out of vectors; preset "b" embeds only
    // unrelated.md, so the embeddings table exists (unlike the table-absent case above) but
    // carries no row at all for target.md.
    const { db, cfg } = openConfig({
      presets: { default: { include: ['**/*.md'] }, b: { include: ['unrelated.md'] } },
      embed: { model: writeModel(), provider: 'static' },
      queries: {},
      baseDir: relatedTree(),
      configPath: null,
    });
    const result = similarNotes(db, cfg, 'target.md', { exclude: new Set(), k: 5 });
    db.close();
    assert.deepEqual(result, []);
  });
});

// The model cache is machine-wide, keyed by model id; anything that is not a Hugging
// Face repo id is a path the caller controls.
describe('model cache location and naming', () => {
  // Every seeded probe id lives under this prefix, so cleanup can't reach into a real model's
  // cache entry even if a test fails before removing its own.
  const seeded: string[] = [];
  after(() => {
    for (const dir of seeded) rmSync(dir, { recursive: true, force: true });
  });

  it('an unresolved Hugging Face id names its (fileless) repo dir under ~/.sense/models', () => {
    // Fixture ids, never real ones: a real id resolves on any machine whose owner has
    // actually downloaded it, and this test is about the unresolved shape.
    const a = modelDir('sense-test-fixture/unresolved-a');
    const b = modelDir('sense-test-fixture/unresolved-b');
    assert.match(a, /\.sense[/\\]models[/\\]models--sense-test-fixture--unresolved-a$/);
    assert.match(b, /\.sense[/\\]models[/\\]models--sense-test-fixture--unresolved-b$/);
    assert.notEqual(a, b, 'two models coexist rather than sharing a directory');
  });

  it('a local path is used as a path, never mangled into a cache key', () => {
    // A path (POSIX, Windows drive letter, or relative) is used as-is, never mangled into a
    // cache-key-style directory name.
    for (const path of ['./local-model', '/abs/path/model', 'C:\\models\\mine', 'a/b/c', 'noslash']) {
      assert.equal(modelDir(path), path, path);
    }
  });

  it('a local path is not downloadable, and says so instead of fetching a bogus repo', async () => {
    assert.equal(isDownloadable('minishlab/potion-retrieval-32M'), true);
    assert.equal(isDownloadable('/abs/path/model'), false);
    await assert.rejects(() => downloadModel('/abs/path/model'), /is a local path, not a Hugging Face model id/);
  });

  it('a recorded refs/main resolves the snapshot dir and is reused without a network request', async () => {
    const model = `sense-test-fixture/probe-${process.pid}-${Date.now()}`;
    const sha = 'f'.repeat(40);
    const repoDir = seedModelCache(model, sha);
    seeded.push(repoDir);

    assert.match(modelDir(model), new RegExp(`snapshots[/\\\\]${sha}$`));
    assert.equal(hasModelFiles(model), true);
    // Both files are already present at the recorded sha, so this must resolve nothing over
    // the network -- if it tried, a sandboxed/offline run would hang or throw here instead.
    const dir = await downloadModel(model);
    assert.equal(dir, modelDir(model));
  });

  it('~/.sense/models is the one cache root; the old XDG-relocatable cache is orphaned', () => {
    assert.equal(modelDir('org/name').includes(homedir()), true);
  });
});

// A heading-dense seed multiplies the full-corpus scan, so seed chunks are sampled. This
// checks the sampling still finds what an unsampled scan would.
describe('related on a heading-dense note', () => {
  it('still surfaces the similar note when the seed has far more chunks than the cap', async () => {
    const baseDir = tmpTree();
    const sections = Array.from({ length: 60 }, (_, i) => `## Section ${i}\n\napple`).join('\n\n');
    writeNote(baseDir, 'target.md', { frontmatter: { title: 'Target' }, body: sections });
    writeNote(baseDir, 'similar.md', { frontmatter: { title: 'Similar' }, body: 'pomme' });
    writeNote(baseDir, 'unrelated.md', { frontmatter: { title: 'Unrelated' }, body: 'stone' });

    const { db, cfg } = openSemantic(baseDir, { model: writeModel(), provider: 'static' });
    const result = await relatedNotes(db, cfg, 'target.md', {}, 5);
    db.close();
    assert.equal(result[0]?.path, 'similar.md', JSON.stringify(result));
  });
});

// Mirrors 'semantic expansion surfaces a note FTS5 cannot reach' (embed feature, above) in three
// more scripts: same mechanism (chunk -> vector -> nearest -> via=vector), not model quality. A
// writeModel local path has no languages.json, so the language-fit check stays off throughout --
// none of these trip EMBED_MODEL_MISMATCH.
describe('multilingual semantic mechanism', () => {
  const cases: Array<{ name: string; near: [string, string]; far: string }> = [
    { name: 'Japanese', near: ['りんご', 'みかん'], far: '壁' },
    { name: 'Chinese', near: ['苹果', '香蕉'], far: '墙' },
    { name: 'Russian', near: ['яблоко', 'банан'], far: 'стена' },
  ];

  for (const { name, near, far } of cases) {
    const [seed, query] = near;
    it(`${name}: a query with zero lexical overlap still surfaces the note, labeled via=vector`, async () => {
      const baseDir = tmpTree();
      writeNote(baseDir, 'a.md', { body: seed });
      writeNote(baseDir, 'b.md', { body: far });
      const { db, cfg } = openSemantic(baseDir, { model: writeModel([near, [far]]), provider: 'static' });
      const rows = (await search(db, cfg, query)) as Array<{ path: string; via: string; lines: string }>;
      db.close();
      const hit = rows[0];
      assert.equal(hit.path, 'a.md', JSON.stringify(rows));
      assert.equal(hit.via, 'vector');
      assert.match(hit.lines, /^L\d+-\d+$/);
    });
  }
});

// The fit check: franc-min classifies the chunk texts embedPending is about to embed, and
// a seeded languages.json (no network) drives the decision.
describe('language fit check', () => {
  const seeded: string[] = [];
  after(() => {
    for (const dir of seeded) rmSync(dir, { recursive: true, force: true });
  });

  // A fixture id per test, seeded with (or without) a hand-written languages.json; no network,
  // since seedModelCache already writes the files, refs/main, and (optionally) languages.json.
  function chineseModel(languages?: string[]): string {
    if (languages === undefined) return writeModel();
    const model = `sense-test-fixture/langfit-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    seeded.push(seedModelCache(model, 'a'.repeat(40), { languages }));
    return model;
  }

  it('a majority-Chinese tree under a model declaring only English throws EMBED_MODEL_MISMATCH naming the model, its languages, the majority, and the fix', async () => {
    const { db, cfg } = openSemantic(chineseTree(), { model: chineseModel(['en']), provider: 'static' });
    await assert.rejects(
      () => search(db, cfg, 'anything'),
      (err: SenseError) => {
        assert.equal(err.code, 'EMBED_MODEL_MISMATCH');
        assert.match(err.message, /declares languages \[en\]/);
        assert.match(err.message, /"cmn"/);
        assert.match(err.message, /choose a model for this tree's languages/);
        assert.match(err.message, /sense init --model/);
        return true;
      }
    );
    db.close();
  });

  it('the same tree passes when the model also declares zh', async () => {
    const { db, cfg } = openSemantic(chineseTree(), { model: chineseModel(['en', 'zh']), provider: 'static' });
    const rows = await search(db, cfg, 'anything');
    db.close();
    assert.ok(Array.isArray(rows));
  });

  it('no languages.json at all: the check stays off regardless of majority', async () => {
    const { db, cfg } = openSemantic(chineseTree(), { model: chineseModel(undefined), provider: 'static' });
    const rows = await search(db, cfg, 'anything');
    db.close();
    assert.ok(Array.isArray(rows));
  });

  it('a mixed tree with no clear majority records the distribution instead of erroring', async () => {
    const baseDir = tmpTree();
    const zh = ['今天的天气非常适合在公园里散步和放松心情。', '我喜欢在周末和朋友一起看电影。', '这座城市的夜景真的非常漂亮。', '他正在学习如何弹吉他和唱歌。'];
    const en = ['The weather today is absolutely beautiful for a walk in the park.', 'I enjoy watching movies with my friends on the weekend.', 'The city looks absolutely stunning at night with all its lights.', 'He is learning how to play the guitar and sing along.'];
    const ru = ['Сегодня прекрасная погода для прогулки в парке возле дома.', 'Мне нравится смотреть фильмы с друзьями по выходным.', 'Ночной город выглядит просто потрясающе с этими огнями.', 'Он учится играть на гитаре и петь одновременно.'];
    for (const [lang, sentences] of [
      ['zh', zh],
      ['en', en],
      ['ru', ru],
    ] as const) {
      writeNote(baseDir, `${lang}.md`, { body: sentences.map((s, i) => `## S${i}\n\n${s}`).join('\n\n') });
    }
    const { db, cfg } = openSemantic(baseDir, { model: chineseModel(['en']), provider: 'static' });
    const rows = await search(db, cfg, 'anything');
    const dist = languageDistribution(db);
    db.close();
    assert.ok(Array.isArray(rows));
    assert.ok(dist, 'a distribution is recorded even without an error');
    const total = Object.values(dist as Record<string, number>).reduce((a, b) => a + b, 0);
    assert.ok(total >= 10, `expected enough classified chunks to clear the floor, got ${JSON.stringify(dist)}`);
    for (const count of Object.values(dist as Record<string, number>)) {
      assert.ok(count / total < 0.5, `no language should dominate: ${JSON.stringify(dist)}`);
    }
  });

  it('sense status prints the declared languages and the detected distribution', () => {
    const baseDir = chineseTree();
    const model = chineseModel(['en', 'zh']);
    writeFileSync(join(baseDir, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['**/*.md'] } }, embed: { model, provider: 'static' }, queries: {} }));
    const searched = runCli(['search', 'anything'], { cwd: baseDir });
    assert.equal(searched.status, 0, searched.stderr);
    const result = runCli(['status', '--format=json'], { cwd: baseDir });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as { embed: { languages: string[]; detectedLanguages: Record<string, number> } };
    assert.deepEqual(parsed.embed.languages, ['en', 'zh']);
    assert.ok(parsed.embed.detectedLanguages.cmn > 0, JSON.stringify(parsed.embed.detectedLanguages));

    const text = runCli(['status'], { cwd: baseDir });
    assert.match(text.stdout, /languages: en, zh \(declared by the model card\)/);
    assert.match(text.stdout, /detected: cmn \d+% \(\d+ chunks classified\)/);
  });
});

describe('query that rewrites to nothing', () => {
  it('unspaced-script punctuation alone returns zero rows, not an FTS5 syntax error', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'zh.md', { frontmatter: { title: '笔记' }, body: '季度审查会议。' });
    const { db, cfg } = openConfig({ presets: { default: { include: ['**/*.md'] } }, queries: {}, baseDir, configPath: null });
    const rows = await search(db, cfg, '。');
    db.close();
    assert.deepEqual(rows, []);
  });
});
