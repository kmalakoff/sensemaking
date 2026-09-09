import assert from 'node:assert';
import { search } from 'sensemaking';
import type { Store } from '../../src/store/types.ts';
import { writeModel } from '../lib/model.ts';
import { forEachStore, type ParityStoreName, withTreeForStore } from '../lib/stores.ts';
import { tmpTree, writeNote } from '../lib/tree.ts';

interface SectionRow {
  path: string;
  idx: number;
  heading: string;
  start_line: number;
  end_line: number;
}

async function rows<T>(store: Store, sql: string): Promise<T[]> {
  return (await (await store.prepare(sql)).all()) as T[];
}

function sortedPending(rows: Array<{ path: string; chunk: number }>) {
  return rows.map(({ path, chunk }) => ({ path, chunk: Number(chunk) })).sort((a, b) => a.path.localeCompare(b.path) || a.chunk - b.chunk);
}

function embedConfig(model: string, chunkTokens?: number) {
  return { model, provider: 'static' as const, ...(chunkTokens === undefined ? {} : { chunkTokens }) };
}

function modelTree(): string {
  const baseDir = tmpTree();
  writeNote(baseDir, 'a.md', { frontmatter: { title: 'Orchard' }, body: '# Orchard\n\napple orchard' });
  writeNote(baseDir, 'b.md', { frontmatter: { title: 'Wall' }, body: '# Wall\n\nstone wall' });
  return baseDir;
}

// The 72-character body lines cost 18 tokens; at chunkTokens:100 each heading seed fits 5 lines
// (93/93.5 tokens with newlines), not 6 (111.25/111.75), yielding 5+5+2.
const CHUNK_BODY = [
  '# First',
  '',
  'alpha apple stone pear orchard garden fruit harvest season tree soil sun',
  'alpha apple stone pear orchard garden fruit harvest season tree soil sun',
  'alpha apple stone pear orchard garden fruit harvest season tree soil sun',
  'alpha apple stone pear orchard garden fruit harvest season tree soil sun',
  'alpha apple stone pear orchard garden fruit harvest season tree soil sun',
  'alpha apple stone pear orchard garden fruit harvest season tree soil sun',
  'alpha apple stone pear orchard garden fruit harvest season tree soil sun',
  'alpha apple stone pear orchard garden fruit harvest season tree soil sun',
  'alpha apple stone pear orchard garden fruit harvest season tree soil sun',
  'alpha apple stone pear orchard garden fruit harvest season tree soil sun',
  'alpha apple stone pear orchard garden fruit harvest season tree soil sun',
  'alpha apple stone pear orchard garden fruit harvest season tree soil sun',
  '',
  '## Second',
  '',
  'pomme apple stone pear orchard garden fruit harvest season tree soil sun',
  'pomme apple stone pear orchard garden fruit harvest season tree soil sun',
  'pomme apple stone pear orchard garden fruit harvest season tree soil sun',
  'pomme apple stone pear orchard garden fruit harvest season tree soil sun',
  'pomme apple stone pear orchard garden fruit harvest season tree soil sun',
  'pomme apple stone pear orchard garden fruit harvest season tree soil sun',
  'pomme apple stone pear orchard garden fruit harvest season tree soil sun',
  'pomme apple stone pear orchard garden fruit harvest season tree soil sun',
  'pomme apple stone pear orchard garden fruit harvest season tree soil sun',
  'pomme apple stone pear orchard garden fruit harvest season tree soil sun',
  'pomme apple stone pear orchard garden fruit harvest season tree soil sun',
  'pomme apple stone pear orchard garden fruit harvest season tree soil sun',
].join('\n');

function chunkTree(): string {
  const baseDir = tmpTree();
  writeNote(baseDir, 'chunked.md', { frontmatter: { title: 'Chunked' }, body: CHUNK_BODY });
  return baseDir;
}

function normalizeEmbeddings(rows: Array<Record<string, unknown>>, materialized = false) {
  return rows.map((row) => {
    assert.ok('vector' in row, 'embeddings query must project vector');
    if (materialized) {
      assert.notEqual(row.vector, null, 'materialized embedding must have a non-null vector');
      assert.notEqual(row.vector, undefined, 'embeddings query must return a vector value');
    }
    return { path: String(row.path), chunk: Number(row.chunk), start_line: Number(row.start_line), end_line: Number(row.end_line), vector: row.vector !== null && row.vector !== undefined };
  });
}

function normalizeSections(rows: SectionRow[]) {
  return rows.map(({ path, idx, heading, start_line, end_line }) => ({ path, idx: Number(idx), heading, start_line: Number(start_line), end_line: Number(end_line) }));
}

describe('embedding invalidation across stores', () => {
  it('model-only changes clear vector values while preserving content, sections, and chunk rows', async () => {
    await forEachStore(async (store: ParityStoreName) => {
      const baseDir = modelTree();
      const modelA = writeModel([['apple', 'pomme'], ['stone']]);
      const modelB = writeModel([['stone'], ['apple', 'pomme']]);
      const expectedChunks = [
        { path: 'a.md', chunk: 0, start_line: 5, end_line: 7 },
        { path: 'b.md', chunk: 0, start_line: 5, end_line: 7 },
      ];
      const expectedContent = [
        { path: 'a.md', title: 'Orchard', text: 'Orchard apple orchard' },
        { path: 'b.md', title: 'Wall', text: 'Wall stone wall' },
      ];
      const expectedSections = [
        { path: 'a.md', idx: 0, heading: 'Orchard', start_line: 5, end_line: 8 },
        { path: 'b.md', idx: 0, heading: 'Wall', start_line: 5, end_line: 8 },
      ];

      const before = await withTreeForStore(
        store,
        baseDir,
        async ({ store: opened, cfg }) => {
          await search(opened, cfg, 'apple');
          return {
            chunks: normalizeEmbeddings(await rows<Record<string, unknown>>(opened, 'SELECT "path", chunk, start_line, end_line, vector FROM embeddings ORDER BY "path", chunk'), true),
            content: await rows<{ path: string; title: string; text: string }>(opened, 'SELECT "path", title, text FROM content ORDER BY "path"'),
            sections: normalizeSections(await rows<SectionRow>(opened, 'SELECT "path", idx, heading, start_line, end_line FROM sections ORDER BY "path", idx')),
            pending: sortedPending(await opened.vectors.pending()),
            hasA: await opened.vectors.hasVector('a.md'),
            hasB: await opened.vectors.hasVector('b.md'),
          };
        },
        { embed: embedConfig(modelA) }
      );

      assert.deepEqual(
        before.chunks,
        expectedChunks.map((row) => ({ ...row, vector: true })),
        `${store}: initial authored chunk rows`
      );
      assert.deepEqual(before.content, expectedContent, `${store}: initial authored content`);
      assert.deepEqual(before.sections, expectedSections, `${store}: initial authored sections`);
      assert.deepEqual(before.pending, [], `${store}: initial vectors must be materialized`);
      assert.equal(before.hasA, true, `${store}: a.md initial vector`);
      assert.equal(before.hasB, true, `${store}: b.md initial vector`);

      const after = await withTreeForStore(
        store,
        baseDir,
        async ({ store: opened }) => ({
          chunks: normalizeEmbeddings(await rows<Record<string, unknown>>(opened, 'SELECT "path", chunk, start_line, end_line, vector FROM embeddings ORDER BY "path", chunk')),
          content: await rows<{ path: string; title: string; text: string }>(opened, 'SELECT "path", title, text FROM content ORDER BY "path"'),
          sections: normalizeSections(await rows<SectionRow>(opened, 'SELECT "path", idx, heading, start_line, end_line FROM sections ORDER BY "path", idx')),
          pending: sortedPending(await opened.vectors.pending()),
          hasA: await opened.vectors.hasVector('a.md'),
          hasB: await opened.vectors.hasVector('b.md'),
        }),
        { embed: embedConfig(modelB) }
      );

      assert.deepEqual(
        after.chunks,
        expectedChunks.map((row) => ({ ...row, vector: false })),
        `${store}: model change preserves chunks and clears vectors`
      );
      assert.deepEqual(after.content, expectedContent, `${store}: model change preserves content`);
      assert.deepEqual(after.sections, expectedSections, `${store}: model change preserves sections`);
      assert.deepEqual(after.pending, sortedPending(expectedChunks.map(({ path, chunk }) => ({ path, chunk }))), `${store}: model change pending rows`);
      assert.equal(after.hasA, false, `${store}: a.md must be pending after model change`);
      assert.equal(after.hasB, false, `${store}: b.md must be pending after model change`);
    });
  });

  it('chunk-token changes rebuild exact authored boundaries and leave every new row pending', async () => {
    await forEachStore(async (store: ParityStoreName) => {
      const baseDir = chunkTree();
      const model = writeModel([['apple', 'pomme'], ['stone']]);
      const expectedSections = [
        { path: 'chunked.md', idx: 0, heading: 'First', start_line: 5, end_line: 19 },
        { path: 'chunked.md', idx: 1, heading: 'Second', start_line: 20, end_line: 34 },
      ];
      const defaultChunks = [
        { path: 'chunked.md', chunk: 0, start_line: 5, end_line: 18 },
        { path: 'chunked.md', chunk: 1, start_line: 20, end_line: 33 },
      ];
      const smallChunks = [
        { path: 'chunked.md', chunk: 0, start_line: 5, end_line: 11 },
        { path: 'chunked.md', chunk: 1, start_line: 12, end_line: 16 },
        { path: 'chunked.md', chunk: 2, start_line: 17, end_line: 18 },
        { path: 'chunked.md', chunk: 3, start_line: 20, end_line: 26 },
        { path: 'chunked.md', chunk: 4, start_line: 27, end_line: 31 },
        { path: 'chunked.md', chunk: 5, start_line: 32, end_line: 33 },
      ];

      const before = await withTreeForStore(
        store,
        baseDir,
        async ({ store: opened, cfg }) => {
          await search(opened, cfg, 'apple');
          return {
            chunks: normalizeEmbeddings(await rows<Record<string, unknown>>(opened, 'SELECT "path", chunk, start_line, end_line, vector FROM embeddings ORDER BY "path", chunk'), true),
            sections: normalizeSections(await rows<SectionRow>(opened, 'SELECT "path", idx, heading, start_line, end_line FROM sections ORDER BY "path", idx')),
            pending: sortedPending(await opened.vectors.pending()),
          };
        },
        { embed: embedConfig(model) }
      );

      assert.deepEqual(
        before.chunks,
        defaultChunks.map((row) => ({ ...row, vector: true })),
        `${store}: default authored chunks`
      );
      assert.deepEqual(before.sections, expectedSections, `${store}: initial authored sections`);
      assert.deepEqual(before.pending, [], `${store}: default chunks must be materialized`);

      const after = await withTreeForStore(
        store,
        baseDir,
        async ({ store: opened }) => ({
          chunks: normalizeEmbeddings(await rows<Record<string, unknown>>(opened, 'SELECT "path", chunk, start_line, end_line, vector FROM embeddings ORDER BY "path", chunk')),
          sections: normalizeSections(await rows<SectionRow>(opened, 'SELECT "path", idx, heading, start_line, end_line FROM sections ORDER BY "path", idx')),
          pending: sortedPending(await opened.vectors.pending()),
        }),
        { embed: embedConfig(model, 100) }
      );

      assert.deepEqual(
        after.chunks,
        smallChunks.map((row) => ({ ...row, vector: false })),
        `${store}: chunk-token change authored chunks`
      );
      assert.deepEqual(after.sections, expectedSections, `${store}: chunk-token change preserves sections`);
      assert.deepEqual(after.pending, sortedPending(smallChunks.map(({ path, chunk }) => ({ path, chunk }))), `${store}: chunk-token change pending rows`);
    });
  });

  it('re-embedding after a model change answers the authored semantic query', async () => {
    await forEachStore(async (store: ParityStoreName) => {
      const baseDir = modelTree();
      const modelA = writeModel([['apple'], ['pomme'], ['stone']]);
      const modelB = writeModel([['apple', 'pomme'], ['stone']]);

      const before = await withTreeForStore(
        store,
        baseDir,
        async ({ store: opened, cfg }) => {
          await search(opened, cfg, 'apple');
          const rows = (await search(opened, cfg, 'pomme')) as Array<{ path: string; similarity: number }>;
          return { rows, pending: sortedPending(await opened.vectors.pending()) };
        },
        { embed: embedConfig(modelA) }
      );
      assert.deepEqual(before.pending, [], `${store}: initial model vectors must be materialized`);
      assert.ok(
        before.rows.every((row) => row.similarity <= 0.9),
        `${store}: pomme must not match apple before the model change: ${JSON.stringify(before.rows)}`
      );

      const after = await withTreeForStore(
        store,
        baseDir,
        async ({ store: opened, cfg }) => {
          const pendingBefore = sortedPending(await opened.vectors.pending());
          const rows = (await search(opened, cfg, 'pomme')) as Array<{ path: string; via: string; similarity: number }>;
          return { pendingBefore, pendingAfter: sortedPending(await opened.vectors.pending()), rows };
        },
        { embed: embedConfig(modelB) }
      );

      assert.deepEqual(
        after.pendingBefore,
        sortedPending([
          { path: 'a.md', chunk: 0 },
          { path: 'b.md', chunk: 0 },
        ]),
        `${store}: changed model must invalidate every vector row`
      );
      assert.deepEqual(after.pendingAfter, [], `${store}: search must re-embed all pending rows`);
      assert.equal(after.rows[0]?.path, 'a.md', `${store}: pomme semantic answer`);
      assert.equal(after.rows[0]?.via, 'vector', `${store}: pomme answer provenance`);
      assert.ok((after.rows[0]?.similarity ?? 0) > 0.9, `${store}: pomme must be near apple after re-embedding: ${JSON.stringify(after.rows)}`);
    });
  });
});
