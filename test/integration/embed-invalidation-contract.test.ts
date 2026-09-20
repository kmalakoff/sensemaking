import assert from 'node:assert';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { type ResolvedConfig, search } from 'sensemaking';
import { featureSignature } from '../../src/config/index.ts';
import { takeChunkText } from '../../src/embed/handoff.ts';
import { embedPending } from '../../src/embed/query.ts';
import { FEATURES } from '../../src/features/index.ts';
import { getMeta, openStoreFor, setMeta } from '../../src/store/index.ts';
import { type BuildRequirement, prepareDocumentEmbeddings } from '../../src/store/open.ts';
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

function withoutEmbedIdentity(signature: string): string {
  return signature
    .split('|')
    .map((part) => (part.startsWith('embed:') ? part.replace(/@.*$/, '') : part))
    .join('|');
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
  it('publishes a newly materialized model identity only after local vectors succeed', async () => {
    const baseDir = modelTree();
    const cfg = {
      store: 'sqlite',
      presets: { default: { include: ['**/*.md'], signals: { vectors: 1 } } },
      embed: embedConfig(writeModel()),
      queries: {},
      baseDir,
      configPath: null,
    } as ResolvedConfig;
    const opened = await openStoreFor(cfg, { build: true, requirements: new Set<BuildRequirement>(['core']) });
    const actual = featureSignature(cfg, FEATURES);
    const unresolved = withoutEmbedIdentity(actual);
    assert.notEqual(unresolved, actual, 'fixture model must have a local identity to withhold');
    try {
      await setMeta(opened.store, 'features', unresolved);
      await prepareDocumentEmbeddings(opened.store, cfg, new Set(['a.md']));
      assert.equal(await getMeta(opened.store, 'features'), actual);
      assert.equal(await opened.store.vectors.hasVector('a.md'), true);
      assert.equal(await opened.store.vectors.hasVector('b.md'), false, 'scoped preparation must leave unrelated chunks pending');
    } finally {
      await opened.store.close();
    }

    const observed = await openStoreFor(cfg, { build: false, requirements: new Set<BuildRequirement>(['core', 'vectors']) });
    await observed.store.close();
  });

  it('does not publish model identity when another signature key also changed', async () => {
    const baseDir = modelTree();
    const cfg = {
      store: 'sqlite',
      presets: { default: { include: ['**/*.md'], signals: { vectors: 1 } } },
      embed: embedConfig(writeModel()),
      queries: {},
      baseDir,
      configPath: null,
    } as ResolvedConfig;
    const opened = await openStoreFor(cfg, { build: true, requirements: new Set<BuildRequirement>(['core']) });
    const incompatible = withoutEmbedIdentity(featureSignature(cfg, FEATURES)).replace('feature:tags:on', 'feature:tags:off');
    try {
      await setMeta(opened.store, 'features', incompatible);
      await assert.rejects(() => prepareDocumentEmbeddings(opened.store, cfg, new Set(['a.md'])), /configuration changed while vectors were being prepared/);
      assert.equal(await opened.store.vectors.hasVector('a.md'), true, 'the guard must run after real vector preparation');
      assert.equal(await getMeta(opened.store, 'features'), incompatible, 'an unrelated signature change must not be adopted');
    } finally {
      await opened.store.close();
    }
  });

  it('keeps prepared lexical search usable after vector preparation fails', async () => {
    await forEachStore(async (store) => {
      const baseDir = modelTree();
      const cfg = {
        store,
        presets: {
          default: { include: ['**/*.md'], signals: { words: 1, vectors: 1 } },
          lexical: { include: ['**/*.md'], signals: { words: 1 } },
        },
        embed: embedConfig('/nonexistent/sense-v1-model'),
        queries: {},
        baseDir,
        configPath: null,
      } as ResolvedConfig;

      await assert.rejects(() => openStoreFor(cfg, { build: true, requirements: new Set<BuildRequirement>(['core', 'lexical', 'vectors']) }), /embed model .* is not available/);
      const opened = await openStoreFor(cfg, { build: false, requirements: new Set<BuildRequirement>(['core', 'lexical']) });
      try {
        const result = (await search(opened.store, cfg, 'apple', { preset: 'lexical' })) as Array<{ path: string }>;
        assert.equal(result[0]?.path, 'a.md', `${store}: vector failure blocked lexical readiness`);
      } finally {
        await opened.store.close();
      }
    });
  });

  it('no-build semantic readiness ignores pending chunks outside the requested scope', async () => {
    await forEachStore(async (store) => {
      const baseDir = modelTree();
      const cfg = {
        store,
        presets: {
          default: { include: ['a.md'], signals: { vectors: 1 } },
          other: { include: ['b.md'], signals: { vectors: 1 } },
        },
        embed: embedConfig(writeModel([['apple'], ['stone']])),
        queries: {},
        baseDir,
        configPath: null,
      } as ResolvedConfig;
      const built = await openStoreFor(cfg, { build: true, requirements: new Set<BuildRequirement>(['core']) });
      await embedPending(built.store, cfg, new Set(['a.md']));
      await built.store.close();

      const opened = await openStoreFor(cfg, { build: false, requirements: new Set<BuildRequirement>(['core', 'vectors']) });
      try {
        const result = (await search(opened.store, cfg, 'apple', { preset: 'default' })) as Array<{ path: string }>;
        assert.equal(result[0]?.path, 'a.md', `${store}: complete requested scope did not answer`);
        assert.ok(
          (await opened.store.vectors.pending()).some((row) => row.path === 'b.md'),
          `${store}: fixture lost its unrelated pending row`
        );
      } finally {
        await opened.store.close();
      }
    });
  });

  it('prepares delayed chunks from the stored indexed source after the live file vanishes', async () => {
    await forEachStore(async (store) => {
      const baseDir = modelTree();
      const cfg = { store, presets: { default: { include: ['**/*.md'] } }, embed: embedConfig(writeModel()), queries: {}, baseDir, configPath: null } as ResolvedConfig;
      const opened = await openStoreFor(cfg, { build: true, requirements: new Set<BuildRequirement>(['core']) });
      try {
        assert.ok((await opened.store.vectors.pending()).some((row) => row.path === 'a.md'));
        assert.ok(takeChunkText(opened.store), `${store}: fixture must discard the same-process handoff`);
        unlinkSync(join(baseDir, 'a.md'));
        await embedPending(opened.store, cfg, new Set(['a.md']));
        assert.equal(
          (await opened.store.vectors.pending()).some((row) => row.path === 'a.md'),
          false,
          `${store}: delayed embedding consulted the vanished live path`
        );
        assert.equal(await opened.store.vectors.hasVector('a.md'), true, `${store}: stored source did not produce a vector`);
      } finally {
        await opened.store.close();
      }
    });
  });

  it('model-only changes re-prepare vectors while preserving content, sections, and chunk rows', async () => {
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
        expectedChunks.map((row) => ({ ...row, vector: true })),
        `${store}: model change preserves chunks and prepares replacement vectors`
      );
      assert.deepEqual(after.content, expectedContent, `${store}: model change preserves content`);
      assert.deepEqual(after.sections, expectedSections, `${store}: model change preserves sections`);
      assert.deepEqual(after.pending, [], `${store}: public open must finish model-change preparation`);
      assert.equal(after.hasA, true, `${store}: a.md replacement vector`);
      assert.equal(after.hasB, true, `${store}: b.md replacement vector`);
    });
  });

  it('chunk-token changes rebuild exact authored boundaries and prepare every new row', async () => {
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
        smallChunks.map((row) => ({ ...row, vector: true })),
        `${store}: chunk-token change authored chunks`
      );
      assert.deepEqual(after.sections, expectedSections, `${store}: chunk-token change preserves sections`);
      assert.deepEqual(after.pending, [], `${store}: chunk-token change prepared rows`);
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

      assert.deepEqual(after.pendingBefore, [], `${store}: public open must complete changed-model preparation`);
      assert.deepEqual(after.pendingAfter, [], `${store}: search must re-embed all pending rows`);
      assert.equal(after.rows[0]?.path, 'a.md', `${store}: pomme semantic answer`);
      assert.equal(after.rows[0]?.via, 'vector', `${store}: pomme answer provenance`);
      assert.ok((after.rows[0]?.similarity ?? 0) > 0.9, `${store}: pomme must be near apple after re-embedding: ${JSON.stringify(after.rows)}`);
    });
  });
});
