import assert from 'assert';
import { mkdtempSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { find } from 'sensemaking';
import { openTree, tmpTree, writeNote } from '../lib/tree.ts';

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

describe('embed feature', () => {
  it('semantic expansion surfaces a note FTS5 cannot reach, labeled via=vector with a lines range', async () => {
    const { db, cfg } = openTree(fruitTree(), { embed: { model: writeModel(), type: 'static' } });
    const rows = (await find(db, cfg, 'pomme', { semantic: true })) as Array<{ path: string; via: string; lines: string }>;
    db.close();
    const hit = rows[0];
    assert.equal(hit.path, 'a.md', JSON.stringify(rows));
    assert.equal(hit.via, 'vector'); // zero FTS matches for 'pomme'
    assert.match(hit.lines, /^L\d+-\d+$/);
  });

  it('a term both matched and vector-near composes via=match+vector', async () => {
    const { db, cfg } = openTree(fruitTree(), { embed: { model: writeModel(), type: 'static' } });
    const rows = (await find(db, cfg, 'apple', { semantic: true })) as Array<{ path: string; via: string }>;
    db.close();
    assert.equal(rows[0].path, 'a.md');
    // link expansion re-includes match seeds, so the full composition is match+link+vector
    assert.match(rows[0].via, /^match\+.*vector$/);
  });

  it('bit-identity: with embed enabled but not invoked, find results are unchanged', async () => {
    const treeA = fruitTree();
    const treeB = fruitTree();
    const on = openTree(treeA, { embed: { model: writeModel(), type: 'static' } });
    const off = openTree(treeB);
    const rowsOn = await find(on.db, on.cfg, 'apple OR stone');
    const rowsOff = await find(off.db, off.cfg, 'apple OR stone');
    on.db.close();
    off.db.close();
    assert.deepEqual(rowsOn, rowsOff);
  });

  it('--semantic without features.embed is a named error', async () => {
    const { db, cfg } = openTree(fruitTree());
    await assert.rejects(find(db, cfg, 'pomme', { semantic: true }), (err: Error & { code?: string }) => {
      assert.equal(err.code, 'EMBED_DISABLED');
      return true;
    });
    db.close();
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
    const { db, cfg } = openTree(fruitTree(), { embed: { model: 'test-model', type: 'api', url } });
    const rows = (await find(db, cfg, 'pomme', { semantic: true })) as Array<{ path: string; via: string }>;
    db.close();
    assert.equal(rows[0].path, 'a.md', JSON.stringify(rows));
    assert.equal(rows[0].via, 'vector');
  });
});

describe('semantic absence signal', () => {
  it('vector rows carry cosine similarity: a real match runs high, absent vocabulary near zero', async () => {
    const { db, cfg } = openTree(fruitTree(), { embed: { model: writeModel(), type: 'static' } });

    const absent = await find(db, cfg, 'zzznotaword');
    assert.equal(absent.length, 0, 'lexical find answers absence with zero rows');

    const semantic = (await find(db, cfg, 'zzznotaword', { semantic: true })) as Array<{ via: string; similarity: number }>;
    assert.ok(semantic.length > 0, 'nearest-neighbour search always returns a neighbour');
    for (const row of semantic) {
      assert.equal(row.via, 'vector');
      assert.ok(Math.abs(row.similarity) < 0.05, `unknown vocabulary embeds to ~zero, got ${row.similarity}`);
    }

    const real = (await find(db, cfg, 'pomme', { semantic: true })) as Array<{ path: string; similarity: number }>;
    assert.ok(real[0].similarity > 0.9, `apple ≡ pomme in the fixture, got ${real[0].similarity}`);
    db.close();
  });
});
