import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { unlinkSync, utimesSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { type ResolvedConfig, search } from 'sensemaking';
import { featureSignature } from '../../src/config/index.ts';
import { takeChunkText } from '../../src/embed/handoff.ts';
import { embedPending } from '../../src/embed/query.ts';
import { STORE_DIMS } from '../../src/embed/types.ts';
import { type Chunk, embed } from '../../src/features/embed.ts';
import { FEATURES } from '../../src/features/index.ts';
import { getMeta, openStoreFor, setMeta } from '../../src/store/index.ts';
import { type BuildRequirement, prepareDocumentEmbeddings } from '../../src/store/open.ts';
import type { Store } from '../../src/store/types.ts';
import { writeModel } from '../lib/model.ts';
import { listen } from '../lib/server.ts';
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

function publicationTree(body: string): string {
  const baseDir = tmpTree();
  writeNote(baseDir, 'race.md', { frontmatter: { title: 'Race' }, body: `# Race\n\n${body}` });
  writeNote(baseDir, 'steady.md', { frontmatter: { title: 'Steady' }, body: '# Steady\n\nsteady-marker' });
  return baseDir;
}

async function controlledProvider() {
  let releaseDocuments!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseDocuments = () => resolve();
  });
  let markDocumentsStarted!: () => void;
  const documentsStarted = new Promise<void>((resolve) => {
    markDocumentsStarted = () => resolve();
  });
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = JSON.parse(raw) as { input: string[] };
      const reply = () => {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            data: body.input.map((text) => ({ embedding: text.includes('replacement-marker') ? [0, 1] : [1, 0] })),
          })
        );
      };
      if (body.input.length === 1 && body.input[0] === 'dimension probe') {
        reply();
        return;
      }
      markDocumentsStarted();
      void released.then(reply);
    });
  });
  const endpoint = await listen(server);
  return { documentsStarted, endpoint, releaseDocuments, server };
}

async function cancelableBatchProvider() {
  let documentRequests = 0;
  let markSecondBatchStarted!: () => void;
  const secondBatchStarted = new Promise<void>((resolve) => {
    markSecondBatchStarted = () => resolve();
  });
  let releaseSecondBatch!: () => void;
  const secondBatchReleased = new Promise<void>((resolve) => {
    releaseSecondBatch = () => resolve();
  });
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = JSON.parse(raw) as { input: string[] };
      const reply = () => {
        if (res.destroyed) return;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: body.input.map(() => ({ embedding: [1, 0] })) }));
      };
      if (body.input.length === 1 && body.input[0] === 'dimension probe') {
        reply();
        return;
      }
      documentRequests++;
      if (documentRequests === 1) {
        reply();
        return;
      }
      markSecondBatchStarted();
      void secondBatchReleased.then(reply);
    });
  });
  const endpoint = await listen(server);
  return {
    endpoint,
    get documentRequests() {
      return documentRequests;
    },
    releaseSecondBatch,
    secondBatchStarted,
    server,
  };
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function preserveBodyAndCleanup(body: () => Promise<void>, cleanup: () => Promise<void>): Promise<void> {
  const [bodyResult] = await Promise.allSettled([body()]);
  const [cleanupResult] = await Promise.allSettled([cleanup()]);
  if (bodyResult.status === 'rejected' && cleanupResult.status === 'rejected') {
    throw new AggregateError([bodyResult.reason, cleanupResult.reason], 'test body and cleanup both failed');
  }
  if (bodyResult.status === 'rejected') throw bodyResult.reason;
  if (cleanupResult.status === 'rejected') throw cleanupResult.reason;
}

function observeOperation(operation: Promise<void>): Promise<PromiseSettledResult<void>> {
  return Promise.allSettled([operation]).then(([result]) => result);
}

async function awaitDocumentRequest(documentsStarted: Promise<void>, operation: Promise<PromiseSettledResult<void>>): Promise<PromiseSettledResult<void> | null> {
  const first = await Promise.race([documentsStarted.then(() => ({ kind: 'started' as const })), operation.then((result) => ({ kind: 'settled' as const, result }))]);
  return first.kind === 'settled' ? first.result : null;
}

function operationError(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

async function cleanupPublicationRace(provider: Awaited<ReturnType<typeof controlledProvider>>, opened: Awaited<ReturnType<typeof openStoreFor>> | undefined, pendingOutcome: Promise<PromiseSettledResult<void>> | undefined, pendingConsumed: boolean): Promise<void> {
  provider.releaseDocuments();
  const errors: unknown[] = [];
  if (pendingOutcome && !pendingConsumed) {
    const pending = await pendingOutcome;
    if (pending.status === 'rejected') errors.push(pending.reason);
  }
  if (opened) {
    try {
      await opened.store.close();
    } catch (err) {
      errors.push(err);
    }
  }
  try {
    await closeServer(provider.server);
  } catch (err) {
    errors.push(err);
  }
  if (errors.length > 0) throw new AggregateError(errors, 'publication-race cleanup failed');
}

function remoteConfig(baseDir: string, url: string, model: string): ResolvedConfig {
  return {
    store: 'sqlite',
    presets: { default: { include: ['**/*.md'], signals: { vectors: 1 } } },
    embed: { model, provider: 'openai', url },
    queries: {},
    baseDir,
    configPath: null,
  };
}

async function storedSqliteVectors(store: Store) {
  return (await rows<{ path: string; chunk: number; scale: number | null; vector: Uint8Array | null }>(store, 'SELECT "path", chunk, scale, vector FROM embeddings ORDER BY "path", chunk')).map((row) => ({
    path: row.path,
    chunk: Number(row.chunk),
    scale: row.scale === null ? null : Number(row.scale),
    vector: row.vector === null ? null : [...row.vector],
  }));
}

async function storedChunks(store: Store) {
  return (await rows<Record<string, unknown>>(store, 'SELECT "path", chunk, start_line, end_line, content_identity, scale, vector FROM embeddings ORDER BY "path", chunk')).map((row) => {
    const vector = row.vector;
    assert.ok(vector === null || Array.isArray(vector) || ArrayBuffer.isView(vector), 'real store must return the native array or blob');
    return {
      path: String(row.path),
      chunk: Number(row.chunk),
      start_line: Number(row.start_line),
      end_line: Number(row.end_line),
      content_identity: String(row.content_identity),
      scale: row.scale === null ? null : Number(row.scale),
      vector: vector === null ? null : Array.from(vector as ArrayLike<number>),
    };
  });
}

function authoredUnitVector(store: ParityStoreName, axis = 0): number[] {
  if (store === 'sqlite') return axis === 0 ? [127, 0] : [0, 127];
  if (store === 'duckdb') return Array.from({ length: STORE_DIMS }, (_, i) => (i === axis ? 1 : 0));
  const bytes = Buffer.alloc(STORE_DIMS * 4);
  bytes.writeFloatLE(1, axis * 4);
  return [...bytes];
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
  it('reuses completed and pending chunks after stamp-only reparses without retaining unchanged text', async () => {
    const requests: string[][] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const { input } = JSON.parse(raw) as { input: string[] };
        if (!(input.length === 1 && input[0] === 'dimension probe')) requests.push(input);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: input.map((text) => ({ embedding: text.includes('changed-marker') ? [0, 1] : [1, 0] })) }));
      });
    });
    const endpoint = await listen(server);
    await preserveBodyAndCleanup(
      async () => {
        await forEachStore(async (store) => {
          const baseDir = modelTree();
          const cfg: ResolvedConfig = { ...remoteConfig(baseDir, endpoint, `reuse-${store}`), store };
          const openCore = () => openStoreFor(cfg, { build: true, requirements: new Set<BuildRequirement>(['core']) });
          const initial = await openCore();
          await preserveBodyAndCleanup(
            async () => {
              assert.deepEqual(sortedPending(await initial.store.vectors.pending()), [
                { path: 'a.md', chunk: 0 },
                { path: 'b.md', chunk: 0 },
              ]);
            },
            () => initial.store.close()
          );
          // Matching pending rows have no new handoff; preparation must use indexed_sources.
          const future = new Date(Date.now() + 5_000);
          utimesSync(join(baseDir, 'a.md'), future, future);
          const pending = await openCore();
          let completed: Awaited<ReturnType<typeof storedChunks>> = [];
          await preserveBodyAndCleanup(
            async () => {
              assert.equal(pending.parsed, 1);
              assert.equal(takeChunkText(pending.store), undefined);
              requests.length = 0;
              await prepareDocumentEmbeddings(pending.store, cfg);
              assert.equal(requests.flat().length, 2, 'matched pending rows still need provider work');
              completed = await storedChunks(pending.store);
              assert.deepEqual(
                completed.map(({ path, chunk, start_line, end_line, scale, vector }) => ({ path, chunk, start_line, end_line, scale, vector })),
                ['a.md', 'b.md'].map((path) => ({
                  path,
                  chunk: 0,
                  start_line: 5,
                  end_line: 7,
                  scale: store === 'sqlite' ? 1 / 127 : null,
                  vector: authoredUnitVector(store),
                }))
              );
            },
            () => pending.store.close()
          );

          utimesSync(join(baseDir, 'a.md'), new Date(future.getTime() + 5_000), new Date(future.getTime() + 5_000));
          const unchanged = await openCore();
          await preserveBodyAndCleanup(
            async () => {
              assert.equal(unchanged.parsed, 1);
              assert.equal(takeChunkText(unchanged.store), undefined);
              requests.length = 0;
              await prepareDocumentEmbeddings(unchanged.store, cfg);
              await prepareDocumentEmbeddings(unchanged.store, cfg);
              assert.deepEqual(requests, [], 'completed unchanged chunks must issue zero document requests');
              assert.deepEqual(await storedChunks(unchanged.store), completed);
            },
            () => unchanged.store.close()
          );

          writeNote(baseDir, 'a.md', { frontmatter: { title: 'Orchard', unrelated: 'metadata' }, body: '# Orchard\n\napple orchard' });
          const moved = await openCore();
          await preserveBodyAndCleanup(
            async () => {
              assert.equal(moved.parsed, 1);
              requests.length = 0;
              await prepareDocumentEmbeddings(moved.store, cfg);
              assert.deepEqual(requests, []);
              assert.equal(takeChunkText(moved.store), undefined);
              assert.deepEqual(
                await storedChunks(moved.store),
                completed.map((row) => (row.path === 'a.md' ? { ...row, start_line: 6, end_line: 8 } : row))
              );
            },
            () => moved.store.close()
          );

          writeNote(baseDir, 'b.md', { frontmatter: { title: 'Changed wall' }, body: '# Wall\n\nchanged-marker' });
          const edited = await openCore();
          let afterEdit: Awaited<ReturnType<typeof storedChunks>> = [];
          await preserveBodyAndCleanup(
            async () => {
              assert.equal(edited.parsed, 1);
              assert.deepEqual(sortedPending(await edited.store.vectors.pending()), [{ path: 'b.md', chunk: 0 }]);
              requests.length = 0;
              await prepareDocumentEmbeddings(edited.store, cfg);
              assert.equal(requests.flat().length, 1, 'only the changed chunk needs provider work');
              assert.ok(requests[0][0].includes('Changed wall'));
              assert.ok(requests[0][0].includes('changed-marker'));
              afterEdit = await storedChunks(edited.store);
              assert.deepEqual(afterEdit[0], { ...completed[0], start_line: 6, end_line: 8 });
              assert.deepEqual({ scale: afterEdit[1].scale, vector: afterEdit[1].vector }, { scale: store === 'sqlite' ? 1 / 127 : null, vector: authoredUnitVector(store, 1) });
            },
            () => edited.store.close()
          );

          unlinkSync(join(baseDir, 'b.md'));
          const optedOut: ResolvedConfig = {
            ...cfg,
            presets: {
              default: { include: ['**/*.md'], signals: { words: 1 } },
              vectors: { include: ['b.md'], signals: { vectors: 1 } },
            },
          };
          const removed = await openStoreFor(optedOut, { build: true, requirements: new Set<BuildRequirement>(['core']) });
          await preserveBodyAndCleanup(
            async () => {
              assert.deepEqual(await storedChunks(removed.store), [], 'vanished and newly opted-out paths must have no embedding rows');
              requests.length = 0;
              await prepareDocumentEmbeddings(removed.store, optedOut);
              assert.deepEqual(requests, []);
            },
            () => removed.store.close()
          );
        });
      },
      () => closeServer(server)
    );
  });

  it('diffs more than 512 real chunks across boundary deletions, preserving later vectors and rolling back failures', async () => {
    await forEachStore(async (store) => {
      const baseDir = tmpTree();
      const cfg: ResolvedConfig = { store, presets: { default: { include: ['**/*.md'], signals: { vectors: 1 } } }, embed: embedConfig(writeModel()), queries: {}, baseDir, configPath: null };
      const storeChunks = embed.store;
      const removeChunks = embed.remove;
      assert.ok(storeChunks);
      assert.ok(removeChunks);
      const opened = await openStoreFor(cfg, { build: true, requirements: new Set<BuildRequirement>(['core']) });
      const db = opened.store;
      const originalPrepare = db.prepare;
      let metadataReads = 0;
      db.prepare = async (sql) => {
        if (sql.startsWith('SELECT chunk, start_line, end_line, content_identity FROM embeddings')) metadataReads++;
        return originalPrepare.call(db, sql);
      };
      await preserveBodyAndCleanup(
        async () => {
          const chunks: Chunk[] = Array.from({ length: 514 }, (_, i) => ({ text: `authored chunk ${i}`, startLine: i * 2 + 1, endLine: i * 2 + 2 }));
          const delta = { files: [], reparsed: ['page.md'], added: ['page.md'], vanished: [] };
          await db.transaction(() => storeChunks(db, [{ path: 'page.md', extracted: chunks }], delta));
          assert.equal(metadataReads, 0, 'known additions must not read old metadata');
          assert.equal(takeChunkText(db)?.get('page.md')?.length, 514);
          await db.vectors.writeVectors([0, 511, 512].map((chunk) => ({ path: 'page.md', chunk, scale: 1 / 127, vector: Buffer.from([127, 0]) })));
          const changed = chunks.slice(0, 513).map((chunk, i) => {
            if (i === 511) return { ...chunk, text: 'replacement at the page boundary' };
            if (i === 512) return { ...chunk, startLine: 2001, endLine: 2002 };
            return chunk;
          });
          const existing = { ...delta, added: [] };
          await db.transaction(() => storeChunks(db, [{ path: 'page.md', extracted: changed }], existing));
          assert.equal(metadataReads, 2, 'comparison prepares the initial and continuation metadata queries');
          const exact = await storedChunks(db);
          assert.deepEqual(
            exact,
            Array.from({ length: 513 }, (_, chunk) => {
              const materialized = chunk === 0 || chunk === 512;
              const text = chunk === 511 ? 'replacement at the page boundary' : `authored chunk ${chunk}`;
              return {
                path: 'page.md',
                chunk,
                start_line: chunk === 512 ? 2001 : chunk * 2 + 1,
                end_line: chunk === 512 ? 2002 : chunk * 2 + 2,
                content_identity: createHash('sha256').update(text).digest('hex'),
                scale: materialized && store === 'sqlite' ? 1 / 127 : null,
                vector: materialized ? authoredUnitVector(store) : null,
              };
            })
          );
          assert.equal(takeChunkText(db)?.get('page.md')?.length, 513);
          await db.transaction(() => storeChunks(db, [{ path: 'page.md', extracted: changed }], existing));
          assert.equal(takeChunkText(db), undefined, 'repeated matching pending work must fall back to the indexed source');
          assert.deepEqual(await storedChunks(db), exact);

          let reachedNativeFailure = false;
          await assert.rejects(() =>
            db.transaction(async () => {
              await storeChunks(db, [{ path: 'page.md', extracted: [{ ...changed[0], text: 'rollback replacement' }, ...changed.slice(1)] }], existing);
              reachedNativeFailure = true;
              await db.exec("INSERT INTO embeddings (\"path\", chunk, start_line, end_line, content_identity) VALUES ('page.md', 0, 1, 2, 'duplicate')");
            })
          );
          assert.equal(reachedNativeFailure, true, 'the real chunk diff must finish before the authored native constraint failure');
          assert.deepEqual(await storedChunks(db), exact, 'late native failure must restore identities, coordinates, pending rows and exact vectors');
          takeChunkText(db);
          await db.transaction(() => storeChunks(db, [{ path: 'page.md', extracted: changed }], existing));
          assert.deepEqual(await storedChunks(db), exact, 'the connection must remain reusable after rollback');
          await db.transaction(() => removeChunks(db, ['page.md'], existing));
          assert.deepEqual(await storedChunks(db), exact, 'reparsed existing paths must survive remove');
          await db.exec('DELETE FROM embeddings WHERE "path" = \'page.md\' AND chunk = 0');
          await db.transaction(() => storeChunks(db, [{ path: 'page.md', extracted: changed }], existing));
          assert.deepEqual(
            await storedChunks(db),
            exact.map((row) => (row.chunk === 0 ? { ...row, scale: null, vector: null } : row)),
            'a missing row must become pending without changing retained vectors'
          );
          takeChunkText(db);
          await db.transaction(() => storeChunks(db, [{ path: 'page.md', extracted: undefined }], existing));
          assert.deepEqual(await storedChunks(db), [], 'opting out must delete all chunks');
          await db.transaction(() => storeChunks(db, [{ path: 'page.md', extracted: chunks.slice(0, 1) }], delta));
          await db.transaction(() => removeChunks(db, ['page.md'], { ...existing, vanished: ['page.md'] }));
          assert.deepEqual(await storedChunks(db), [], 'vanished paths must delete their chunks');
          takeChunkText(db);
        },
        async () => {
          db.prepare = originalPrepare;
          await db.close();
        }
      );
    });
  });

  it('clears matching text for simultaneous model/chunk changes and incomplete-generation recovery', async () => {
    await forEachStore(async (store) => {
      const baseDir = modelTree();
      const cfg: ResolvedConfig = { store, presets: { default: { include: ['**/*.md'], signals: { vectors: 1 } } }, embed: embedConfig(writeModel([['apple'], ['stone']])), queries: {}, baseDir, configPath: null };
      const initial = await openStoreFor(cfg, { build: true, requirements: new Set<BuildRequirement>(['core', 'vectors']) });
      let before: Awaited<ReturnType<typeof storedChunks>> = [];
      await preserveBodyAndCleanup(
        async () => {
          before = await storedChunks(initial.store);
        },
        () => initial.store.close()
      );
      const changed: ResolvedConfig = { ...cfg, embed: embedConfig(writeModel([['apple', 'pomme'], ['stone']]), 100) };
      const invalidated = await openStoreFor(changed, { build: true, requirements: new Set<BuildRequirement>(['core']) });
      await preserveBodyAndCleanup(
        async () => {
          assert.deepEqual(
            await storedChunks(invalidated.store),
            before.map((row) => ({ ...row, scale: null, vector: null }))
          );
          assert.deepEqual(sortedPending(await invalidated.store.vectors.pending()), [
            { path: 'a.md', chunk: 0 },
            { path: 'b.md', chunk: 0 },
          ]);
          await prepareDocumentEmbeddings(invalidated.store, changed);
          assert.deepEqual(await invalidated.store.vectors.pending(), []);
          await setMeta(invalidated.store, 'core_ready', '0');
        },
        () => invalidated.store.close()
      );
      const recovered = await openStoreFor(changed, { build: true, requirements: new Set<BuildRequirement>(['core']) });
      await preserveBodyAndCleanup(
        async () => {
          assert.equal(recovered.parsed, 2);
          assert.deepEqual(
            await storedChunks(recovered.store),
            before.map((row) => ({ ...row, scale: null, vector: null }))
          );
          assert.equal(await getMeta(recovered.store, 'core_ready'), '1');
          await prepareDocumentEmbeddings(recovered.store, changed);
          assert.deepEqual(await recovered.store.vectors.pending(), []);
        },
        () => recovered.store.close()
      );
    });
  });

  // The loopback provider proves endpoint routing and publication glue. It does not model an
  // external service's embedding quality.
  it('an endpoint-only change preserves SQLite core rows and chunk metadata while replacing vectors', async () => {
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = JSON.parse(raw) as { input: string[] };
        const embedding = req.url?.startsWith('/second/') ? [0, 1] : [1, 0];
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: body.input.map(() => ({ embedding })) }));
      });
    });
    const endpoint = await listen(server);
    try {
      const baseDir = modelTree();
      const config = (url: string): ResolvedConfig => ({
        store: 'sqlite',
        presets: { default: { include: ['**/*.md'], signals: { vectors: 1 } } },
        embed: { model: 'same-model', provider: 'openai', url },
        queries: {},
        baseDir,
        configPath: null,
      });
      const firstConfig = config(`${endpoint}/first`);
      const secondConfig = config(`${endpoint}/second`);
      const snapshot = async (store: Store) => ({
        frontmatter: await rows(store, 'SELECT "path", title, _size FROM frontmatter ORDER BY "path"'),
        content: await rows(store, 'SELECT "path", title, text FROM content ORDER BY "path"'),
        sources: await rows(store, 'SELECT "path", text FROM indexed_sources ORDER BY "path"'),
        chunks: await rows<{ path: string; chunk: number; start_line: number; end_line: number }>(store, 'SELECT "path", chunk, start_line, end_line FROM embeddings ORDER BY "path", chunk'),
      });
      const storedVectors = async (store: Store) =>
        (await rows<{ path: string; chunk: number; scale: number; vector: Uint8Array }>(store, 'SELECT "path", chunk, scale, vector FROM embeddings ORDER BY "path", chunk')).map((row) => ({
          path: row.path,
          chunk: Number(row.chunk),
          scale: Number(row.scale),
          vector: [...row.vector],
        }));
      const first = await openStoreFor(firstConfig, { build: true, requirements: new Set<BuildRequirement>(['core', 'vectors']) });
      let before: Awaited<ReturnType<typeof snapshot>>;
      try {
        before = await snapshot(first.store);
        assert.deepEqual(
          before.chunks.map(({ path, chunk }) => ({ path, chunk: Number(chunk) })),
          [
            { path: 'a.md', chunk: 0 },
            { path: 'b.md', chunk: 0 },
          ]
        );
        assert.deepEqual(await storedVectors(first.store), [
          { path: 'a.md', chunk: 0, scale: 1 / 127, vector: [127, 0] },
          { path: 'b.md', chunk: 0, scale: 1 / 127, vector: [127, 0] },
        ]);
      } finally {
        await first.store.close();
      }

      await assert.rejects(() => openStoreFor(secondConfig, { build: false, requirements: new Set<BuildRequirement>(['core', 'vectors']) }), /built for different configuration features/);

      const invalidated = await openStoreFor(secondConfig, { build: true, requirements: new Set<BuildRequirement>(['core']) });
      try {
        assert.equal(invalidated.parsed, 0, 'endpoint-only invalidation must not reparse source files');
        assert.deepEqual(await snapshot(invalidated.store), before);
        assert.equal((await invalidated.store.vectors.pending()).length, before.chunks.length);
      } finally {
        await invalidated.store.close();
      }

      const rebuilt = await openStoreFor(secondConfig, { build: true, requirements: new Set<BuildRequirement>(['core', 'vectors']) });
      try {
        assert.deepEqual(await snapshot(rebuilt.store), before);
        assert.deepEqual(await rebuilt.store.vectors.pending(), []);
        assert.deepEqual(await storedVectors(rebuilt.store), [
          { path: 'a.md', chunk: 0, scale: 1 / 127, vector: [0, 127] },
          { path: 'b.md', chunk: 0, scale: 1 / 127, vector: [0, 127] },
        ]);
      } finally {
        await rebuilt.store.close();
      }

      const equivalent = await openStoreFor(config(`${endpoint}/second/`), { build: false, requirements: new Set<BuildRequirement>(['core', 'vectors']) });
      await equivalent.store.close();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  // The controlled loopback provider proves publication fencing and rollback only. It does not
  // model an external service's embedding quality.
  it('rolls back a provider batch when a concurrent build replaces its indexed chunk', async () => {
    const provider = await controlledProvider();
    let opened: Awaited<ReturnType<typeof openStoreFor>> | undefined;
    let pendingOutcome: Promise<PromiseSettledResult<void>> | undefined;
    let pendingConsumed = false;
    await preserveBodyAndCleanup(
      async () => {
        const baseDir = publicationTree('original-marker');
        const cfg = remoteConfig(baseDir, provider.endpoint, 'replacement-race');
        const active = await openStoreFor(cfg, { build: true, requirements: new Set<BuildRequirement>(['core']) });
        opened = active;
        pendingOutcome = observeOperation(embedPending(active.store, cfg));
        const early = await awaitDocumentRequest(provider.documentsStarted, pendingOutcome);
        if (early) {
          pendingConsumed = true;
          if (early.status === 'rejected') throw early.reason;
          throw new Error('embedding completed before the controlled document request started');
        }

        writeNote(baseDir, 'race.md', { frontmatter: { title: 'Race' }, body: '# Race\n\nreplacement-marker' });
        const replacement = await openStoreFor(cfg, { build: true, requirements: new Set<BuildRequirement>(['core']) });
        await preserveBodyAndCleanup(
          async () => assert.equal(replacement.parsed, 1, 'the concurrent builder must publish replacement chunk metadata'),
          () => replacement.store.close()
        );

        provider.releaseDocuments();
        const rejected = await pendingOutcome;
        pendingConsumed = true;
        if (rejected.status !== 'rejected') assert.fail('the stale provider batch unexpectedly published');
        assert.match(operationError(rejected.reason), /indexed chunks changed while a provider batch was running/);
        assert.deepEqual(
          await storedSqliteVectors(active.store),
          [
            { path: 'race.md', chunk: 0, scale: null, vector: null },
            { path: 'steady.md', chunk: 0, scale: null, vector: null },
          ],
          'a rejected batch must roll back every vector write, including unchanged chunks'
        );

        await embedPending(active.store, cfg);
        assert.deepEqual(
          await storedSqliteVectors(active.store),
          [
            { path: 'race.md', chunk: 0, scale: 1 / 127, vector: [0, 127] },
            { path: 'steady.md', chunk: 0, scale: 1 / 127, vector: [127, 0] },
          ],
          'a fresh pass must embed the replacement content'
        );
      },
      () => cleanupPublicationRace(provider, opened, pendingOutcome, pendingConsumed)
    );
  });

  it('publishes a provider result when a concurrent rebuild preserves exact chunk content', async () => {
    const provider = await controlledProvider();
    let opened: Awaited<ReturnType<typeof openStoreFor>> | undefined;
    let pendingOutcome: Promise<PromiseSettledResult<void>> | undefined;
    let pendingConsumed = false;
    await preserveBodyAndCleanup(
      async () => {
        const baseDir = publicationTree('exact-content-marker');
        const cfg = remoteConfig(baseDir, provider.endpoint, 'exact-content-race');
        const active = await openStoreFor(cfg, { build: true, requirements: new Set<BuildRequirement>(['core']) });
        opened = active;
        pendingOutcome = observeOperation(embedPending(active.store, cfg));
        const early = await awaitDocumentRequest(provider.documentsStarted, pendingOutcome);
        if (early) {
          pendingConsumed = true;
          if (early.status === 'rejected') throw early.reason;
          throw new Error('embedding completed before the controlled document request started');
        }

        writeNote(baseDir, 'race.md', { frontmatter: { title: 'Race' }, body: '# Race\n\nexact-content-marker' });
        const future = new Date(Date.now() + 5_000);
        utimesSync(join(baseDir, 'race.md'), future, future);
        const replacement = await openStoreFor(cfg, { build: true, requirements: new Set<BuildRequirement>(['core']) });
        await preserveBodyAndCleanup(
          async () => assert.equal(replacement.parsed, 1, 'the concurrent builder must reparse the source despite identical content'),
          () => replacement.store.close()
        );

        provider.releaseDocuments();
        const completed = await pendingOutcome;
        pendingConsumed = true;
        if (completed.status === 'rejected') throw completed.reason;
        assert.deepEqual(
          await storedSqliteVectors(active.store),
          [
            { path: 'race.md', chunk: 0, scale: 1 / 127, vector: [127, 0] },
            { path: 'steady.md', chunk: 0, scale: 1 / 127, vector: [127, 0] },
          ],
          'matching content identity may safely accept the in-flight result'
        );
      },
      () => cleanupPublicationRace(provider, opened, pendingOutcome, pendingConsumed)
    );
  });

  it('cancels the current provider batch without withdrawing earlier batches or core publication', async () => {
    const provider = await cancelableBatchProvider();
    let pendingOutcome: Promise<PromiseSettledResult<void>> | undefined;
    let pendingConsumed = false;
    await preserveBodyAndCleanup(
      async () => {
        const baseDir = tmpTree();
        for (let i = 0; i < 65; i++) writeNote(baseDir, `n-${String(i).padStart(2, '0')}.md`, { body: `# Note ${i}\n\nbatch cancellation ${i}` });
        const cfg = remoteConfig(baseDir, provider.endpoint, 'cancel-batch');
        const core = await openStoreFor(cfg, { build: true, requirements: new Set<BuildRequirement>(['core']) });
        let publishedMeta: Array<{ key: string; value: string }>;
        try {
          publishedMeta = await rows(core.store, "SELECT key, value FROM meta WHERE key IN ('features', 'core_ready', 'core_generation') ORDER BY key");
          assert.equal((await rows(core.store, 'SELECT "path" FROM frontmatter')).length, 65);
          assert.equal((await core.store.vectors.pending()).length, 65);
        } finally {
          await core.store.close();
        }

        const reason = { kind: 'authored provider cancellation' };
        const controller = new AbortController();
        pendingOutcome = observeOperation(
          openStoreFor(cfg, { build: true, requirements: new Set<BuildRequirement>(['core', 'vectors']), signal: controller.signal }).then(async (opened) => {
            await opened.store.close();
          })
        );
        const early = await awaitDocumentRequest(provider.secondBatchStarted, pendingOutcome);
        if (early) {
          pendingConsumed = true;
          if (early.status === 'rejected') throw early.reason;
          throw new Error('embedding completed before the controlled second provider batch started');
        }

        controller.abort(reason);
        const canceled = await pendingOutcome;
        pendingConsumed = true;
        assert.equal(canceled.status, 'rejected');
        if (canceled.status === 'rejected') assert.equal(canceled.reason, reason, 'open must preserve the caller-authored cancellation reason');
        assert.equal(provider.documentRequests, 2, 'cancellation unexpectedly submitted another provider batch');

        const reopened = await openStoreFor(cfg, { build: false, requirements: new Set<BuildRequirement>(['core']) });
        try {
          assert.deepEqual(await rows(reopened.store, "SELECT key, value FROM meta WHERE key IN ('features', 'core_ready', 'core_generation') ORDER BY key"), publishedMeta, 'cancellation changed core publication metadata');
          assert.equal((await rows(reopened.store, 'SELECT "path" FROM frontmatter')).length, 65, 'cancellation changed published core rows');
          const vectors = await storedSqliteVectors(reopened.store);
          const committed = vectors.filter((row) => row.vector !== null);
          const pending = vectors.filter((row) => row.vector === null);
          assert.equal(committed.length, 64, 'a previously committed provider batch was lost');
          for (const row of committed) {
            assert.equal(row.scale, 1 / 127);
            assert.deepEqual(row.vector, [127, 0]);
          }
          assert.equal(pending.length, 1, 'the canceled provider batch published a vector');
          assert.equal(pending[0].scale, null);
        } finally {
          await reopened.store.close();
        }
      },
      async () => {
        provider.releaseSecondBatch();
        const errors: unknown[] = [];
        if (pendingOutcome && !pendingConsumed) {
          const pending = await pendingOutcome;
          if (pending.status === 'rejected') errors.push(pending.reason);
        }
        try {
          await closeServer(provider.server);
        } catch (err) {
          errors.push(err);
        }
        if (errors.length > 0) throw new AggregateError(errors, 'provider-cancellation cleanup failed');
      }
    );
  });

  it('rolls back the current vector batch when cancellation arrives after its database write', async () => {
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
    const reason = { kind: 'authored post-write cancellation' };
    const controller = new AbortController();
    const writeVectors = opened.store.vectors.writeVectors;
    opened.store.vectors.writeVectors = async (writes) => {
      await writeVectors.call(opened.store.vectors, writes);
      controller.abort(reason);
    };
    try {
      const [outcome] = await Promise.allSettled([prepareDocumentEmbeddings(opened.store, cfg, undefined, { signal: controller.signal })]);
      assert.equal(outcome.status, 'rejected');
      if (outcome.status === 'rejected') assert.equal(outcome.reason, reason, 'post-write cancellation did not preserve the caller-authored reason');
      const vectors = await storedSqliteVectors(opened.store);
      assert.equal(vectors.length, 2);
      assert.deepEqual(
        vectors.map((row) => ({ path: row.path, scale: row.scale, vector: row.vector })),
        [
          { path: 'a.md', scale: null, vector: null },
          { path: 'b.md', scale: null, vector: null },
        ],
        'the canceled provider batch escaped its transaction'
      );
    } finally {
      opened.store.vectors.writeVectors = writeVectors;
      await opened.store.close();
    }
  });

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

  it('rejects stale configuration before generating vectors or publishing model identity', async () => {
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
      await assert.rejects(() => prepareDocumentEmbeddings(opened.store, cfg, new Set(['a.md'])), /configuration changed before vectors could be prepared/);
      assert.equal(await opened.store.vectors.hasVector('a.md'), false, 'a stale handle must be rejected before provider generation');
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
