import assert from 'node:assert';
import { STORE_DIMS } from '../../src/embed/types.ts';
import { writeModel } from '../lib/model.ts';
import { forEachStore, type openTreeForStore, withTreeForStore } from '../lib/stores.ts';
import { tmpTree, writeNote } from '../lib/tree.ts';
import { cosineOracle } from '../lib/vectors.ts';

const PATHS = ['target.md', 'exact.md', 'a-near.md', 'z-near.md', 'orthogonal.md', 'zero.md', 'anti.md', 'negative-near.md', '\uE000.md', '😀.md'] as const;
type Store = Awaited<ReturnType<typeof openTreeForStore>>['store'];

function contractTree(): string {
  const baseDir = tmpTree();
  for (const path of PATHS) writeNote(baseDir, path, { body: path });
  return baseDir;
}

const WIRES = {
  target: [127, 0],
  exact: [127, 0],
  'a-near': [127, 2],
  'z-near': [127, 1],
  orthogonal: [0, 127],
  zero: [0, 0],
  anti: [-127, 0],
  'negative-near': [-1, ...Array(249).fill(127), ...Array(6).fill(0)],
  '\uE000': [127, 0],
  '😀': [127, 0],
} as const;

function queryVector(): Float32Array {
  const query = new Float32Array(STORE_DIMS);
  query[0] = 1;
  return query;
}

function publicScore(score: number): number {
  return Math.round(Math.min(1, Math.max(-1, score)) * 1000) / 1000;
}

function expectedOrder(query: ArrayLike<number>, names: readonly string[]): Array<{ path: string; similarity: number }> {
  return names
    .map((path) => ({ path, score: cosineOracle(WIRES[path as keyof typeof WIRES], query) }))
    .sort((a, b) => b.score - a.score || Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
    .map(({ path, score }) => ({ path, similarity: publicScore(score) }));
}

async function installVectors(store: Store, pending: Array<{ path: string; chunk: number }>): Promise<void> {
  await store.vectors.writeVectors(
    pending.map(({ path, chunk }) => {
      const values = WIRES[path.replace('.md', '') as keyof typeof WIRES];
      assert.ok(values, `missing wire vector for ${path}`);
      return { path, chunk, scale: 1 / 127, vector: Buffer.from(Int8Array.from(values).buffer) };
    })
  );
}

describe('portable vector contract', () => {
  it('uses independent cosine geometry, neutral zero scores, and true near-tie order in every store', async () => {
    const baseDir = contractTree();
    const model = writeModel();
    await forEachStore(async (name) => {
      await withTreeForStore(
        name,
        baseDir,
        async ({ store }) => {
          const pending = await store.vectors.pending();
          await installVectors(store, pending);
          const query = queryVector();
          const candidateNames = PATHS.map((path) => path.replace('.md', ''));
          const candidates = await store.vectors.candidates(query, STORE_DIMS, 20);
          const expectedCandidates = expectedOrder(query, candidateNames).map(({ path, similarity }) => ({ path: `${path}.md`, similarity }));
          assert.deepEqual(
            candidates.map(({ path, similarity }) => ({ path, similarity })),
            expectedCandidates,
            name
          );
          assert.ok(
            candidates.every((row) => row.lines === 'L5-5'),
            `${name}: candidate line ranges`
          );
          assert.equal(candidates.find((row) => row.path === 'zero.md')?.similarity, 0, name);
          assert.equal(candidates.find((row) => row.path === 'negative-near.md')?.similarity, 0, `${name}: negative half-boundary rounds to neutral public score`);
          assert.deepEqual(
            candidates.filter((row) => row.path === 'a-near.md' || row.path === 'z-near.md').map((row) => row.path),
            ['z-near.md', 'a-near.md'],
            `${name}: distinct raw cosines keep descending order despite equal displayed scores`
          );
          assert.deepEqual(
            (await store.vectors.candidates(query, STORE_DIMS, 2, new Set(['exact.md', 'a-near.md', 'z-near.md']))).map((row) => row.path),
            ['exact.md', 'z-near.md'],
            `${name}: the k boundary uses the unrounded cosine`
          );
          assert.deepEqual(
            candidates.filter((row) => row.path === '\uE000.md' || row.path === '😀.md').map((row) => row.path),
            ['\uE000.md', '😀.md'],
            `${name}: exact cosine ties use UTF-8 bytewise path order`
          );

          const similar = await store.vectors.similar('target.md', { exclude: new Set(), k: 20 });
          const expectedSimilar = expectedOrder(
            WIRES.target,
            candidateNames.filter((path) => path !== 'target')
          ).map(({ path, similarity }) => ({ path: `${path}.md`, similarity }));
          assert.deepEqual(similar, expectedSimilar, name);
        },
        { embed: { model, provider: 'static' } }
      );
    });
  });

  it('uses the earliest authored chunk when a note has equal-scoring chunks', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'tie.md', {
      body: Array.from({ length: 24 }, (_, i) => `line ${i + 1} with enough authored text to form sections`).join('\n'),
    });
    const model = writeModel();
    await forEachStore(async (name) => {
      await withTreeForStore(
        name,
        baseDir,
        async ({ store }) => {
          const chunks = (await (await store.prepare('SELECT chunk, start_line, end_line FROM embeddings WHERE "path" = ? ORDER BY chunk')).all('tie.md')) as Array<{ chunk: number; start_line: number; end_line: number }>;
          assert.ok(chunks.length >= 2, `${name}: fixture must produce at least two authored chunks`);
          const q = new Int8Array(STORE_DIMS);
          q[0] = 127;
          const pending = await store.vectors.pending();
          await store.vectors.writeVectors(pending.map(({ path, chunk }) => ({ path, chunk, scale: 1 / 127, vector: Buffer.from(q.buffer) })));
          const candidates = await store.vectors.candidates(queryVector(), STORE_DIMS, 1);
          assert.deepEqual(
            candidates.map(({ path, lines }) => ({ path, lines })),
            [{ path: 'tie.md', lines: `L${chunks[0].start_line}-${chunks[0].end_line}` }],
            name
          );
        },
        { embed: { model, provider: 'static', chunkTokens: 10 } }
      );
    });
  });
});
