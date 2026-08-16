import assert from 'assert';
import { mkdtempSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Config } from 'sensemaking';
import { presetCoverage, search } from 'sensemaking';
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

// Every test in this file opts semantic back on for the fixture tree -- the local Model2Vec
// fixture above never touches the network.
function openSemantic(baseDir: string, embed: Config['embed']) {
  return openConfig({ presets: { default: { include: ['**/*.md'] } }, embed, queries: {}, baseDir, configPath: null });
}

describe('embed feature', () => {
  it('semantic expansion surfaces a note FTS5 cannot reach, labeled via=vector with a lines range', async () => {
    const { db, cfg } = openSemantic(fruitTree(), { model: writeModel(), type: 'static' });
    const rows = (await search(db, cfg, 'pomme', { semantic: true })) as Array<{ path: string; via: string; lines: string }>;
    db.close();
    const hit = rows[0];
    assert.equal(hit.path, 'a.md', JSON.stringify(rows));
    assert.equal(hit.via, 'vector'); // zero FTS matches for 'pomme'
    assert.match(hit.lines, /^L\d+-\d+$/);
  });

  it('a term both matched and vector-near composes via=match+vector', async () => {
    const { db, cfg } = openSemantic(fruitTree(), { model: writeModel(), type: 'static' });
    const rows = (await search(db, cfg, 'apple', { semantic: true })) as Array<{ path: string; via: string }>;
    db.close();
    assert.equal(rows[0].path, 'a.md');
    // link expansion re-includes match seeds, so the full composition is match+link+vector
    assert.match(rows[0].via, /^match\+.*vector$/);
  });

  it('bit-identity: explicit --lexical opt-out matches a tree that never embeds at all', async () => {
    // Semantic participation is automatic, not opt-in (no flag needed to reach it), so a
    // bare search on a semantic-on preset is *not* the identity baseline here -- the
    // explicit opt-out (--lexical / semantic: false) is what must be bit-identical to a
    // tree with no embedding capability at all.
    const treeA = fruitTree();
    const treeB = fruitTree();
    const on = openSemantic(treeA, { model: writeModel(), type: 'static' });
    const off = openConfig({ presets: { default: { include: ['**/*.md'], semantic: false } }, queries: {}, baseDir: treeB, configPath: null });
    const rowsOn = await search(on.db, on.cfg, 'apple OR stone', { semantic: false });
    const rowsOff = await search(off.db, off.cfg, 'apple OR stone');
    on.db.close();
    off.db.close();
    assert.deepEqual(rowsOn, rowsOff);
  });

  it('requesting semantic on a tree where no preset embeds searches lexically -- fewer signals is not an error', async () => {
    const { db, cfg } = openConfig({ presets: { default: { include: ['**/*.md'], semantic: false } }, queries: {}, baseDir: fruitTree(), configPath: null });
    const rows = (await search(db, cfg, 'pomme', { semantic: true })) as Array<{ path: string; via: string }>;
    db.close();
    // 'pomme' has no lexical match anywhere in the fixture and no preset embeds, so this is
    // simply zero rows, not an error.
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
    const rows = (await search(db, cfg, 'pomme', { semantic: true })) as Array<{ path: string; via: string }>;
    db.close();
    assert.equal(rows[0].path, 'a.md', JSON.stringify(rows));
    assert.equal(rows[0].via, 'vector');
  });
});

describe('semantic absence signal', () => {
  it('vector rows carry cosine similarity: a real match runs high, absent vocabulary near zero', async () => {
    const { db, cfg } = openSemantic(fruitTree(), { model: writeModel(), type: 'static' });

    // Semantic participation is automatic on a semantic-on preset, so the lexical baseline
    // needs the explicit opt-out -- a bare call here would already include vector rows.
    const absent = await search(db, cfg, 'zzznotaword', { semantic: false });
    assert.equal(absent.length, 0, 'lexical search answers absence with zero rows');

    const semantic = (await search(db, cfg, 'zzznotaword', { semantic: true })) as Array<{ via: string; similarity: number }>;
    assert.ok(semantic.length > 0, 'nearest-neighbour search always returns a neighbour');
    for (const row of semantic) {
      assert.equal(row.via, 'vector');
      assert.ok(Math.abs(row.similarity) < 0.05, `unknown vocabulary embeds to ~zero, got ${row.similarity}`);
    }

    const real = (await search(db, cfg, 'pomme', { semantic: true })) as Array<{ path: string; similarity: number }>;
    assert.ok(real[0].similarity > 0.9, `apple ≡ pomme in the fixture, got ${real[0].similarity}`);
    db.close();
  });
});

describe('similarity provenance', () => {
  it('a multi-chunk note reports the best chunk: its similarity and its line range agree', async () => {
    const base = tmpTree();
    // Chunk 1 (heading "Walls"): vector-far from the query. Chunk 2 ("Orchard"): vector-identical.
    writeNote(base, 'two.md', { body: '# Walls\n\nstone walls here\n\n# Orchard\n\nAn apple every day\n' });
    const { db, cfg } = openSemantic(base, { model: writeModel(), type: 'static' });
    const rows = (await search(db, cfg, 'pomme', { semantic: true })) as Array<{ path: string; similarity: number; lines: string }>;
    db.close();
    const hit = rows.find((r) => r.path === 'two.md');
    assert.ok(hit, JSON.stringify(rows));
    assert.ok(hit.similarity > 0.9, `best chunk is the orchard section, got ${hit.similarity}`);
    const [start] = hit.lines.replace('L', '').split('-').map(Number);
    assert.ok(start >= 5, `lines should point at the orchard chunk, got ${hit.lines}`);
  });
});

describe('per-preset semantic', () => {
  it("preset A semantic-on, preset B semantic-off: embeddings rows exist only for A's docs", () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a/one.md', { frontmatter: { title: 'Fruit' }, body: 'An apple every day' });
    writeNote(baseDir, 'b/two.md', { frontmatter: { title: 'Walls' }, body: 'stone walls' });

    const { db } = openConfig({
      presets: { default: { include: ['**/*.md'], semantic: false }, a: { include: ['a/**/*.md'] }, b: { include: ['b/**/*.md'], semantic: false } },
      embed: { model: writeModel(), type: 'static' },
      queries: {},
      baseDir,
      configPath: null,
    });

    const rows = db.prepare('SELECT DISTINCT "path" FROM embeddings').all() as Array<{ path: string }>;
    assert.deepEqual(
      rows.map((r) => r.path),
      ['a/one.md']
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
    assert.deepEqual(before, [{ name: 'default', files: 1, embedded: 0 }]);
    db.close();
  });

  it('a search scoped to the semantic-off preset stays lexical, even though the tree overall has embeddings', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a/one.md', { frontmatter: { title: 'Fruit' }, body: 'An apple every day' });
    writeNote(baseDir, 'b/two.md', { frontmatter: { title: 'Stone' }, body: 'pomme reference for the disabled preset' });

    const { db, cfg } = openConfig({
      presets: { default: { include: ['**/*.md'], semantic: false }, a: { include: ['a/**/*.md'] }, b: { include: ['b/**/*.md'], semantic: false } },
      embed: { model: writeModel(), type: 'static' },
      queries: {},
      baseDir,
      configPath: null,
    });

    const rows = (await search(db, cfg, 'pomme', { preset: 'b', semantic: true })) as Array<{ path: string; via: string }>;
    db.close();
    const hitB = rows.find((r) => r.path === 'b/two.md');
    assert.ok(hitB, JSON.stringify(rows));
    assert.equal(hitB.via, 'match', 'semantic-off preset must be reached lexically only, never via vector');
  });
});
