import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'http';
import type { Config } from 'sensemaking';
import { peek, presetCoverage, search } from 'sensemaking';
import { relatedNotes } from '../../src/commands.ts';
import { downloadModel, isDownloadable, modelDir, similarNotes } from '../../src/features/embed.ts';
import { runCli } from '../lib/cli.ts';
import { openConfig, tmpTree, writeNote } from '../lib/tree.ts';

// Local Model2Vec fixture: WordLevel vocab, 8-dim f32 matrix, apple ≡ pomme (identical
// rows) -- a vector match exists exactly where FTS5 has zero term overlap.
function writeModel(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sense-model-'));
  const vocab = { '[UNK]': 0, apple: 1, pomme: 2, stone: 3 };
  writeFileSync(
    join(dir, 'tokenizer.json'),
    JSON.stringify({
      version: '1.0',
      truncation: null,
      padding: null,
      added_tokens: [],
      normalizer: { type: 'Lowercase' },
      pre_tokenizer: { type: 'WhitespaceSplit' },
      post_processor: null,
      decoder: null,
      model: { type: 'WordLevel', vocab, unk_token: '[UNK]' },
    })
  );
  const rows = [
    [0, 0, 0, 0, 0, 0, 0, 0],
    [1, 0, 0, 0, 0, 0, 0, 0],
    [1, 0, 0, 0, 0, 0, 0, 0],
    [0, 1, 0, 0, 0, 0, 0, 0],
  ];
  const data = new Float32Array(rows.flat());
  const header = Buffer.from(JSON.stringify({ embeddings: { dtype: 'F32', shape: [4, 8], data_offsets: [0, data.byteLength] } }));
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(header.length));
  writeFileSync(join(dir, 'model.safetensors'), Buffer.concat([len, header, Buffer.from(data.buffer)]));
  return dir;
}

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
    writeFileSync(join(baseDir, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['**/*.md'] } }, embed: { model: writeModel(), type: 'static' }, queries: {} }));
    for (const pass of ['first', 'second']) {
      const result = runCli(['download'], { cwd: baseDir });
      assert.equal(result.status, 0, `${pass}: ${result.stderr}`);
      assert.match(result.stdout, /already available/, pass);
    }
  });

  it('search fails rather than silently dropping to two signals: the same query must not answer differently before and after a download', async () => {
    const { db, cfg } = openSemantic(fruitTree(), { model: '/nonexistent/model-xyz', type: 'static' });
    await assert.rejects(() => search(db, cfg, 'apple'), /searches with vectors, but the embedding model is not available/);
    db.close();
  });

  it('a preset that does not ask for vectors is unaffected by a missing model', async () => {
    const { db, cfg } = openConfig({
      presets: { default: { include: ['**/*.md'], semantic: false } },
      embed: { model: '/nonexistent/model-xyz', type: 'static' },
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
    const { db, cfg } = openSemantic(fruitTree(), { model: writeModel(), type: 'static' });
    const rows = (await search(db, cfg, 'pomme')) as Array<{ path: string; via: string; lines: string }>;
    db.close();
    const hit = rows[0];
    assert.equal(hit.path, 'a.md', JSON.stringify(rows));
    assert.equal(hit.via, 'vector'); // zero FTS matches for 'pomme'
    assert.match(hit.lines, /^L\d+-\d+$/);
  });

  it('a term both matched and vector-near composes via=match+vector', async () => {
    const { db, cfg } = openSemantic(fruitTree(), { model: writeModel(), type: 'static' });
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
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`;
  });

  after(() => server.close());

  it('expands through an OpenAI-compatible endpoint', async () => {
    const { db, cfg } = openSemantic(fruitTree(), { model: 'test-model', type: 'api', url });
    const rows = (await search(db, cfg, 'pomme')) as Array<{ path: string; via: string }>;
    db.close();
    assert.equal(rows[0].path, 'a.md', JSON.stringify(rows));
    assert.equal(rows[0].via, 'vector');
  });
});

describe('semantic absence signal', () => {
  it('vector rows carry cosine similarity: a real match runs high, absent vocabulary near zero', async () => {
    const { db, cfg } = openSemantic(fruitTree(), { model: writeModel(), type: 'static' });

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
    const { db } = openSemantic(baseDir, { model: writeModel(), type: 'static' });
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
    const { db } = openSemantic(baseDir, { model: writeModel(), type: 'static' });
    const n = (db.prepare('SELECT COUNT(*) AS n FROM embeddings WHERE "path" = ?').get('stub.md') as { n: number }).n;
    db.close();
    assert.equal(n, 0, 'an empty body embeds to nothing, rather than to a vector of its own YAML');
  });
});

describe('similarity is a cosine, so it is bounded', () => {
  it('two notes with identical text score exactly 1, not 1.001', async () => {
    const baseDir = tmpTree();
    const body = '# Orchard\n\napple orchard prose that both notes share exactly';
    writeNote(baseDir, 'one.md', { frontmatter: { title: 'One' }, body });
    writeNote(baseDir, 'two.md', { frontmatter: { title: 'One' }, body });
    const { db, cfg } = openSemantic(baseDir, { model: writeModel(), type: 'static' });
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
    const { db, cfg } = openSemantic(base, { model: writeModel(), type: 'static' });
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
      embed: { model: writeModel(), type: 'static' },
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
      embed: { model: writeModel(), type: 'static' as const },
      queries: {},
      baseDir,
      configPath: null,
    };
    const { db, cfg } = openConfig(cfgObj);
    // Vectors are lazy: rows exist with vector NULL until the first semantic search. Coverage
    // saying "1 embedded" here contradicted status's own "0 embedded, 1 pending" line.
    const before = presetCoverage(db, cfg);
    assert.deepEqual(before, [{ name: 'default', files: 1, embedded: 0, semantic: true }]);
    db.close();
  });
});

describe('related command', () => {
  it('surfaces a semantically similar note that is not linked, excluding self/outbound/backlinks', async () => {
    const { db, cfg } = openSemantic(relatedTree(), { model: writeModel(), type: 'static' });
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
    const { db, cfg } = openSemantic(relatedTree(), { model: writeModel(), type: 'static' });
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
    const { db, cfg } = openSemantic(baseDir, { model: writeModel(), type: 'static' });
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

  it("errors on a semantic:false preset instead of borrowing another preset's vectors", async () => {
    const baseDir = relatedTree();
    const { db, cfg } = openConfig({
      presets: { default: { include: ['**/*.md'] }, lex: { include: ['**/*.md'], semantic: false } },
      queries: {},
      embed: { model: writeModel(), type: 'static' },
      baseDir,
      configPath: null,
    });
    // The files are embedded, via the overlapping semantic-on preset. Reading the flag is what
    // stops those vectors answering for a scope that declined them.
    await assert.rejects(() => relatedNotes(db, cfg, 'target.md', { preset: 'lex' }, 5), /"semantic": false/);
    db.close();
  });

  it('errors when the seed note has no indexed text, rather than answering []', async () => {
    const baseDir = relatedTree();
    writeNote(baseDir, 'stub.md', { frontmatter: { title: 'Stub' }, body: '' });
    const { db, cfg } = openSemantic(baseDir, { model: writeModel(), type: 'static' });
    await assert.rejects(() => relatedNotes(db, cfg, 'stub.md', {}, 5), /no indexed text/);
    db.close();
  });

  it('computes the lazy vectors itself, so a fresh index answers without a prior semantic search', async () => {
    const { db, cfg } = openSemantic(relatedTree(), { model: writeModel(), type: 'static' });
    const result = await relatedNotes(db, cfg, 'target.md', {}, 5);
    db.close();
    assert.ok(result.map((r) => r.path).includes('similar.md'), JSON.stringify(result));
  });

  it('says the model is missing rather than answering []: an empty table reads as "nothing is related"', async () => {
    const { db, cfg } = openSemantic(relatedTree(), { model: '/nonexistent/model-xyz', type: 'static' });
    await assert.rejects(() => relatedNotes(db, cfg, 'target.md', {}, 5), /not downloaded/);
    db.close();
  });
});

describe('similarNotes (unit)', () => {
  it('ranks by cosine, honoring exclude and self-exclusion', async () => {
    const { db, cfg } = openSemantic(relatedTree(), { model: writeModel(), type: 'static' });
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
    const { db, cfg } = openSemantic(relatedTree(), { model: writeModel(), type: 'static' });
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
      embed: { model: writeModel(), type: 'static' },
      queries: {},
      baseDir: relatedTree(),
      configPath: null,
    });
    const result = similarNotes(db, cfg, 'target.md', { exclude: new Set(), k: 5 });
    db.close();
    assert.deepEqual(result, []);
  });
});

// The model cache is machine-wide (a rebuild throws away .sense/, not a 124 MB model), keyed
// by model id. Anything that is not a Hugging Face repo id is a path the caller controls.
describe('model cache location and naming', () => {
  it('a Hugging Face id becomes one directory per model, slashes flattened', () => {
    const a = modelDir('minishlab/potion-retrieval-32M');
    const b = modelDir('sentence-transformers/all-MiniLM-L6-v2');
    assert.match(a, /sensemaking[/\\]models[/\\]minishlab--potion-retrieval-32M$/);
    assert.match(b, /sensemaking[/\\]models[/\\]sentence-transformers--all-MiniLM-L6-v2$/);
    assert.notEqual(a, b, 'two models coexist rather than sharing a directory');
  });

  it('a local path is used as a path, never mangled into a cache key', () => {
    // `/abs/path/model` used to become `--abs--path--model`, and a Windows path became a
    // directory name containing characters Windows forbids in one.
    for (const path of ['./local-model', '/abs/path/model', 'C:\\models\\mine', 'a/b/c', 'noslash']) {
      assert.equal(modelDir(path), path, path);
    }
  });

  it('a local path is not downloadable, and says so instead of fetching a bogus repo', async () => {
    assert.equal(isDownloadable('minishlab/potion-retrieval-32M'), true);
    assert.equal(isDownloadable('/abs/path/model'), false);
    await assert.rejects(() => downloadModel('/abs/path/model'), /is a local path, not a Hugging Face model id/);
  });

  it('XDG_CACHE_HOME relocates the cache where it is set', () => {
    const original = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = '/tmp/xdg-probe';
    try {
      assert.equal(modelDir('org/name'), join('/tmp/xdg-probe', 'sensemaking', 'models', 'org--name'));
    } finally {
      if (original === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = original;
    }
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

    const { db, cfg } = openSemantic(baseDir, { model: writeModel(), type: 'static' });
    const result = await relatedNotes(db, cfg, 'target.md', {}, 5);
    db.close();
    assert.equal(result[0]?.path, 'similar.md', JSON.stringify(result));
  });
});
