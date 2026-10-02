import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import assert from 'assert';
import { build, loadConfig, open, type ResolvedConfig, SUPPORTED_CONFIG_VERSION, search } from 'sensemaking';
import { startMeasuredWatcher } from '../../benchmark/lib/measured-watcher.mjs';
import { signalProcessTree } from '../../benchmark/lib/native-observer.mjs';
import { readWatchClaim, WATCH_HEARTBEAT_INTERVAL_MS, WATCH_STALE_HEARTBEAT_MS, type WatchClaimRecord } from '../../src/watch-claim.ts';
import { writeModel } from '../lib/model.ts';
import { packageRoot, scratchDir } from '../lib/scratch.ts';
import { listen } from '../lib/server.ts';
import { forEachStore, type ParityStoreName, withTreeForStore } from '../lib/stores.ts';
import { writeNote } from '../lib/tree.ts';

const DEADLINE_MS = 30_000;

async function waitForClaim(configDir: string, predicate: (claim: WatchClaimRecord) => boolean, timeoutMs = DEADLINE_MS): Promise<WatchClaimRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const claim = readWatchClaim(configDir);
    if (claim && predicate(claim)) return claim;
    if (Date.now() >= deadline) throw new Error(`watch claim did not reach the expected state within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function killMeasuredWatcher(watcher: ReturnType<typeof startMeasuredWatcher> | undefined): Promise<void> {
  if (!watcher) return;
  if (watcher.child.pid !== undefined && watcher.child.exitCode === null && watcher.child.signalCode === null) signalProcessTree(watcher.child, 'SIGKILL');
  await watcher.closed;
}

async function controlledMixedClientProvider(queryInput: string) {
  let queryRequests = 0;
  let queryReleased = false;
  let markQueryStarted!: () => void;
  const queryStarted = new Promise<void>((resolve) => {
    markQueryStarted = resolve;
  });
  let releaseHeldQuery!: () => void;
  const heldQueryReleased = new Promise<void>((resolve) => {
    releaseHeldQuery = resolve;
  });
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      let input: string[];
      try {
        const body = JSON.parse(raw) as { input?: unknown };
        if (!Array.isArray(body.input) || !body.input.every((value) => typeof value === 'string')) throw new Error('invalid input');
        input = body.input;
      } catch {
        res.statusCode = 400;
        res.end('invalid fixture request');
        return;
      }
      // This is a scheduling/protocol fixture, not evidence about external embedding quality.
      const reply = () => {
        if (res.destroyed) return;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: input.map((_text, index) => ({ index, embedding: [1, 0] })) }));
      };
      if (input.length === 1 && input[0] === queryInput) {
        queryRequests++;
        markQueryStarted();
        void heldQueryReleased.then(reply);
        return;
      }
      reply();
    });
  });
  const endpoint = await listen(server);
  return {
    endpoint,
    queryStarted,
    get queryReleased() {
      return queryReleased;
    },
    get queryRequests() {
      return queryRequests;
    },
    releaseQuery() {
      if (queryReleased) return;
      queryReleased = true;
      releaseHeldQuery();
    },
    server,
  };
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

async function pendingVectorCount(cfg: ResolvedConfig): Promise<number> {
  const opened = await open(cfg, { build: false });
  let bodyFailed = false;
  let bodyError: unknown;
  let count: number | undefined;
  try {
    count = (await opened.store.vectors.pending()).length;
  } catch (err) {
    bodyFailed = true;
    bodyError = err;
  }
  let closeFailed = false;
  let closeError: unknown;
  try {
    await opened.store.close();
  } catch (err) {
    closeFailed = true;
    closeError = err;
  }
  if (bodyFailed && closeFailed) throw new AggregateError([bodyError, closeError], 'reading vector readiness and closing its store both failed');
  if (bodyFailed) throw bodyError;
  if (closeFailed) throw closeError;
  if (count === undefined) throw new Error('vector readiness read produced no count');
  return count;
}

const CHILD = String.raw`
import { channel } from 'node:diagnostics_channel';
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const role = process.argv[1];
const configPath = process.argv[2];
const packageRoot = process.argv[3];
const releasePath = process.argv[4];
const label = process.argv[5];
const api = await import(pathToFileURL(join(packageRoot, 'dist', 'esm', 'index.js')).href);
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const lockWait = channel('sensemaking.store.lock-wait');
const onLockWait = ({ store }) => send({ type: 'lock-observed', store });
if (role === 'reader' || role === 'reader2' || role === 'writer') lockWait.subscribe(onLockWait);
const buildPlan = channel('sensemaking.store.build-plan');
const pause = new Int32Array(new SharedArrayBuffer(4));
const onBuildPlan = ({ attempt, baseline, wantedSignature }) => {
  send({ type: 'planned', attempt, generation: baseline.generation, wantedSignature, label });
  while (!existsSync(releasePath)) Atomics.wait(pause, 0, 0, 10);
};
if (role === 'builder') buildPlan.subscribe(onBuildPlan);
const candidatesRead = channel('sensemaking.search.candidates-read');
const onCandidatesRead = ({ paths }) => {
  send({ type: 'search-candidates', paths });
  const deadline = Date.now() + 30000;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(releasePath)) {
    if (Date.now() >= deadline) throw new Error('search snapshot release file was not created');
    Atomics.wait(wait, 0, 0, 25);
  }
};
if (role === 'search-reader') candidatesRead.subscribe(onCandidatesRead);
const migrationReady = channel('sensemaking.config.migration-ready');
const onMigrationReady = ({ configPath, from }) => {
  const readyPath = releasePath + '.' + label + '.ready';
  writeFileSync(readyPath + '.pending', JSON.stringify({ configPath, from }), { flag: 'wx' });
  renameSync(readyPath + '.pending', readyPath);
  const deadline = Date.now() + 30000;
  while (!existsSync(releasePath)) {
    if (Date.now() >= deadline) throw new Error('migration release file was not created');
    Atomics.wait(pause, 0, 0, 25);
  }
};
if (role === 'migrator') migrationReady.subscribe(onMigrationReady);
const input = createInterface({ input: process.stdin });
const command = () => new Promise((resolve, reject) => {
  const onLine = (line) => {
    cleanup();
    try { resolve(JSON.parse(line)); } catch (err) { reject(err); }
  };
  const onClose = () => { cleanup(); reject(new Error('parent closed protocol input')); };
  const cleanup = () => {
    input.off('line', onLine);
    input.off('close', onClose);
  };
  input.once('line', onLine);
  input.once('close', onClose);
});

try {
  const cfg = api.loadConfig(configPath);
  if (role === 'migrator') {
    send({ type: 'migration-result', cfg });
    send({ type: 'done' });
  } else if (role === 'builder') {
    const result = await api.build(cfg);
    send({ type: 'built', parsed: result.parsed, label });
    send({ type: 'done' });
  } else if (role === 'writer') {
    const opening = api.open(cfg);
    send({ type: 'open-launched' });
    const opened = await opening;
    try {
      await opened.store.transaction(async () => {
        const update = await opened.store.prepare('UPDATE content SET text = ? WHERE "path" = ?');
        await update.run('committed-a', 'a.md');
        await update.run('committed-b', 'b.md');
        const indexed = await opened.store.prepare('UPDATE indexed_sources SET text = ? WHERE "path" = ?');
        await indexed.run('committed-a', 'a.md');
        await indexed.run('committed-b', 'b.md');
        send({ type: 'held' });
        const release = await command();
        if (release?.type !== 'release') throw new Error('writer expected release command');
      });
      send({ type: 'committed' });
    } finally {
      await opened.store.close();
    }
    send({ type: 'done' });
  } else if (role === 'reader' || role === 'reader2') {
    send({ type: 'ready' });
    const go = await command();
    if (go?.type !== 'go') throw new Error('reader expected go command');
    send({ type: 'attempting' });
    const opening = role === 'reader2' ? api.open(cfg, { build: false }) : api.open(cfg);
    send({ type: 'open-launched' });
    const opened = await opening;
    try {
      send({ type: 'open-ready' });
      const probe = await command();
      if (probe?.type !== 'probe') throw new Error('reader expected probe command');
      const rows = await (await opened.store.prepare('SELECT "path", text FROM content WHERE "path" IN (?, ?) ORDER BY "path"')).all('a.md', 'b.md');
      const snippets = await (await opened.store.prepare('SELECT "path", text FROM indexed_sources WHERE "path" IN (?, ?) ORDER BY "path"')).all('a.md', 'b.md');
      send({ type: 'read-before-release', rows, snippets });
      const release = await command();
      if (release?.type !== 'release') throw new Error('reader expected release command');
      const fresh = await (await opened.store.prepare('SELECT "path", text FROM content WHERE "path" IN (?, ?) ORDER BY "path"')).all('a.md', 'b.md');
      const freshSnippets = await (await opened.store.prepare('SELECT "path", text FROM indexed_sources WHERE "path" IN (?, ?) ORDER BY "path"')).all('a.md', 'b.md');
      send({ type: 'read', rows: fresh, snippets: freshSnippets });
    } finally {
      await opened.store.close();
    }
    send({ type: 'done' });
  } else if (role === 'search-reader') {
    send({ type: 'ready' });
    const go = await command();
    if (go?.type !== 'go') throw new Error('search reader expected go command');
    const opened = await api.open(cfg, { build: false });
    try {
      const rows = await api.search(opened.store, cfg, 'old');
      send({ type: 'search-result', rows });
    } finally {
      await opened.store.close();
    }
    send({ type: 'done' });
  } else {
    throw new Error('unknown child role');
  }
} catch (err) {
  send({ type: 'error', message: err?.stack ?? String(err), ...(role === 'migrator' ? { errno: { code: err?.code, syscall: err?.syscall, path: err?.path, dest: err?.dest } } : {}) });
  process.exitCode = 1;
} finally {
  lockWait.unsubscribe(onLockWait);
  buildPlan.unsubscribe(onBuildPlan);
  candidatesRead.unsubscribe(onCandidatesRead);
  migrationReady.unsubscribe(onMigrationReady);
  input.close();
}
`;

interface Message {
  type: string;
  cfg?: ResolvedConfig;
  errno?: { code?: string; syscall?: string; path?: string; dest?: string };
  store?: string;
  rows?: Array<{ path: string; text?: string; snippets?: string[] }>;
  paths?: string[];
  snippets?: Array<{ path: string; text: string }>;
  message?: string;
  attempt?: number;
  generation?: string | null;
  wantedSignature?: string;
  parsed?: number;
  label?: string;
}

interface ProtocolChild {
  child: ChildProcess;
  messages: Message[];
  stderr: string;
  waitFor(type: string): Promise<Message>;
  send(message: object): void;
  closed: Promise<void>;
}

interface Waiter {
  resolve: (message: Message) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
  close?: () => void;
}

async function waitForAny(process: ProtocolChild, types: string[]): Promise<Message> {
  return Promise.race(types.map((type) => process.waitFor(type)));
}

function startChild(role: 'writer' | 'reader' | 'reader2' | 'builder' | 'search-reader' | 'migrator', configPath: string, releasePath = '', label = ''): ProtocolChild {
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD, role, configPath, packageRoot, releasePath, label], {
    cwd: packageRoot,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages: Message[] = [];
  let stdout = '';
  let stderr = '';
  let failure: Error | undefined;
  const waiters = new Map<string, Waiter[]>();
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const fail = (err: Error): void => {
    failure ??= err;
    const pending = [...waiters.values()].flat();
    waiters.clear();
    for (const waiter of pending) waiter.reject(failure);
  };
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    for (;;) {
      const newline = stdout.indexOf('\n');
      if (newline < 0) break;
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      try {
        const message = JSON.parse(line) as Message;
        messages.push(message);
        if (message.type === 'error') {
          fail(new Error(`child protocol error: ${message.message ?? 'unknown child error'}`));
          return;
        }
        for (const waiter of [...(waiters.get(message.type) ?? [])]) waiter.resolve(message);
        waiters.delete(message.type);
      } catch (err) {
        fail(new Error(`child returned malformed protocol: ${line}`, { cause: err }));
      }
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on('error', (err) => {
    fail(new Error(`child process error: ${err.message}`, { cause: err }));
  });
  const waitFor = (type: string): Promise<Message> => {
    const found = messages.find((message) => message.type === type);
    if (found) return Promise.resolve(found);
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      let waiter: Waiter;
      const cleanup = (): void => {
        if (waiter.timer) clearTimeout(waiter.timer);
        if (waiter.close) child.off('close', waiter.close);
        const pending = waiters.get(type);
        if (!pending) return;
        const index = pending.indexOf(waiter);
        if (index >= 0) pending.splice(index, 1);
        if (pending.length === 0) waiters.delete(type);
      };
      waiter = {
        resolve: (message) => {
          cleanup();
          resolve(message);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      };
      waiter.timer = setTimeout(() => waiter.reject(new Error(`child produced no ${type} within ${DEADLINE_MS}ms; messages=${JSON.stringify(messages)}; stderr=${stderr || 'none'}`)), DEADLINE_MS);
      waiter.close = () => waiter.reject(new Error(`child exited before ${type}: ${child.signalCode ?? child.exitCode}; stderr=${stderr || 'none'}`));
      const list = waiters.get(type) ?? [];
      list.push(waiter);
      waiters.set(type, list);
      child.once('close', waiter.close);
    });
  };
  const send = (message: object): void => {
    child.stdin?.write(`${JSON.stringify(message)}\n`);
  };
  return {
    child,
    messages,
    get stderr() {
      return stderr;
    },
    waitFor,
    send,
    closed,
  };
}

async function runSearchSnapshotOverlap(): Promise<void> {
  const baseDir = scratchDir('search-snapshot-sqlite');
  const configPath = join(baseDir, 'sense.config.json');
  const releaseFile = join(baseDir, 'release-search-reader');
  writeFileSync(configPath, JSON.stringify({ version: SUPPORTED_CONFIG_VERSION, store: 'sqlite', presets: { default: { include: ['**/*.md'], signals: { words: 1 } } }, queries: {} }));
  writeNote(baseDir, 'a.md', { body: 'old alpha' });
  writeNote(baseDir, 'b.md', { body: 'old beta' });
  await withTreeForStore('sqlite', baseDir, async () => {}, { presets: { default: { include: ['**/*.md'], signals: { words: 1 } } } });

  let writer: ProtocolChild | undefined;
  let reader: ProtocolChild | undefined;
  try {
    writer = startChild('writer', configPath);
    await writer.waitFor('held');

    reader = startChild('search-reader', configPath, releaseFile);
    await reader.waitFor('ready');
    reader.send({ type: 'go' });
    const candidates = await reader.waitFor('search-candidates');
    assert.deepEqual(new Set(candidates.paths), new Set(['a.md', 'b.md']), 'the reader selected both rows from the old committed generation');

    writer.send({ type: 'release' });
    await writer.waitFor('committed');
    writeFileSync(releaseFile, 'release');

    const result = await reader.waitFor('search-result');
    assert.deepEqual(new Set(result.rows?.map((row) => row.path)), new Set(['a.md', 'b.md']), 'the ranked rows remain from the same committed generation');
    const snippets = result.rows?.flatMap((row) => row.snippets ?? []) ?? [];
    const unmarkedSnippets = snippets.map((snippet) => snippet.replace(/[«»]/g, ''));
    assert.ok(
      unmarkedSnippets.some((snippet) => snippet.includes('old alpha')),
      JSON.stringify(result.rows)
    );
    assert.ok(
      unmarkedSnippets.some((snippet) => snippet.includes('old beta')),
      JSON.stringify(result.rows)
    );
    assert.ok(
      snippets.every((snippet) => !snippet.includes('committed-')),
      'hydration must not read bytes committed after candidate selection'
    );

    await writer.waitFor('done');
    await reader.waitFor('done');
    await Promise.all([closeChild(writer), closeChild(reader)]);
  } finally {
    await Promise.all([killChild(writer), killChild(reader)]);
  }
}

async function closeChild(process: ProtocolChild): Promise<void> {
  process.child.stdin?.end();
  await process.closed;
}

async function killChild(process: ProtocolChild | undefined): Promise<void> {
  if (!process) return;
  if (process.child.pid !== undefined && process.child.exitCode === null && process.child.signalCode === null) signalProcessTree(process.child, 'SIGKILL');
  await process.closed;
}

async function finishChildren(children: Array<ProtocolChild | undefined>, bodyFailed: boolean, bodyError: unknown, context: string): Promise<void> {
  const cleanup = await Promise.allSettled(children.map(killChild));
  const cleanupErrors = cleanup.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason);
  if (bodyFailed && cleanupErrors.length > 0) throw new AggregateError([bodyError, ...cleanupErrors], `${context} failed and cleanup also failed`);
  if (bodyFailed) throw bodyError;
  if (cleanupErrors.length > 0) throw cleanupErrors.length === 1 ? cleanupErrors[0] : new AggregateError(cleanupErrors, `${context} cleanup failed`);
}

async function runSameInputMigration(): Promise<void> {
  const baseDir = scratchDir('config-same-input');
  const configPath = join(baseDir, 'sense.config.json');
  const releasePath = join(baseDir, 'release-migrators');
  const labels = ['first', 'second'];
  const legacy = { version: 5, store: 'sqlite', root: 'notes', presets: { default: { include: ['**/*.md'], exclude: ['private/**'], signals: { words: 1 } } }, queries: { saved: { search: 'authored migration', k: 7 } }, ownerTag: 'preserve this value' };
  const legacyBytes = Buffer.from(`${JSON.stringify(legacy)}\n`);
  const expected = { version: SUPPORTED_CONFIG_VERSION, store: 'sqlite', root: 'notes', presets: { default: { include: ['**/*.md'], exclude: ['private/**'], signals: { words: 1 } } }, queries: { saved: { search: 'authored migration', k: 7 } }, ownerTag: 'preserve this value', build: true };
  const expectedBytes = Buffer.from(`${JSON.stringify(expected, null, 2)}\n`);
  const expectedResolved = { ...expected, configDir: baseDir, rootDir: resolve(baseDir, 'notes'), baseDir: resolve(baseDir, 'notes'), configPath, migratedFrom: 5, unknownKeys: ['ownerTag'] };
  writeFileSync(configPath, legacyBytes);
  const children: ProtocolChild[] = [];
  let bodyFailed = false;
  let bodyError: unknown;
  try {
    for (const label of labels) children.push(startChild('migrator', configPath, releasePath, label));
    const readiness = await Promise.all(
      children.map(async (child, index) => {
        const readyPath = `${releasePath}.${labels[index]}.ready`;
        const deadline = Date.now() + DEADLINE_MS;
        while (!existsSync(readyPath)) {
          if (child.child.exitCode !== null || child.child.signalCode !== null || child.messages.some((message) => message.type === 'error')) throw new Error(`migrator exited before readiness: ${JSON.stringify(child.messages)}`);
          if (Date.now() >= deadline) throw new Error('migrator did not reach the publication barrier');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return JSON.parse(readFileSync(readyPath, 'utf8')) as { configPath: string; from: number };
      })
    );
    assert.deepEqual(readiness, [
      { configPath, from: 5 },
      { configPath, from: 5 },
    ]);
    assert.deepEqual(readFileSync(configPath), legacyBytes, 'both legacy reads must precede either publication');
    writeFileSync(releasePath, 'release', { flag: 'wx' });

    const outcomes = await Promise.allSettled(
      children.map(async (child) => {
        let timer: NodeJS.Timeout | undefined;
        try {
          return await Promise.race([
            (async () => {
              const result = await child.waitFor('migration-result');
              await child.waitFor('done');
              await closeChild(child);
              assert.deepEqual({ code: child.child.exitCode, signal: child.child.signalCode }, { code: 0, signal: null });
              return result;
            })(),
            new Promise<Message>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error('migrator did not finish and close')), DEADLINE_MS);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      })
    );
    const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected').map((outcome) => outcome.reason);
    if (failures.length > 0) throw new AggregateError(failures, 'same-input migrator outcomes failed');
    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') assert.deepEqual(outcome.value.cfg, expectedResolved);
    }
    assert.deepEqual(readFileSync(configPath), expectedBytes);
    assert.deepEqual(
      readdirSync(baseDir).filter((name) => name.startsWith('sense.config.json.') && name.endsWith('.part')),
      [],
      'both closed migrators must leave no staging residue'
    );
  } catch (err) {
    bodyFailed = true;
    bodyError = err;
  }
  try {
    await finishChildren(children, bodyFailed, bodyError, 'same-input migration');
  } catch (err) {
    let target: unknown;
    try {
      target = readFileSync(configPath, 'utf8');
    } catch (readError) {
      const errno = readError as NodeJS.ErrnoException;
      target = { error: errno.message, code: errno.code, syscall: errno.syscall, path: errno.path };
    }
    const outcomes = children.map((child) => ({ messages: child.messages, stderr: child.stderr, code: child.child.exitCode, signal: child.child.signalCode }));
    throw new Error(`same-input migration failed; outcomes=${JSON.stringify(outcomes)}; finalTarget=${JSON.stringify(target)}`, { cause: err });
  }
}

function writeSqliteConfig(configDir: string, filename: string, rootDir: string): { configPath: string; cfg: ResolvedConfig } {
  const configPath = join(configDir, filename);
  writeFileSync(configPath, JSON.stringify({ version: SUPPORTED_CONFIG_VERSION, root: rootDir, store: 'sqlite', presets: { default: { include: ['**/*.md'] } }, queries: {} }));
  return { configPath, cfg: loadConfig(configPath) };
}

async function publishedState(cfg: ResolvedConfig): Promise<{ generation: string; features: string; sources: Array<{ path: string; text: string }> }> {
  const opened = await open(cfg, { build: false });
  try {
    const generation = (await (await opened.store.prepare("SELECT value FROM meta WHERE key = 'core_generation'")).get()) as { value: string } | undefined;
    if (!generation) throw new Error('published index has no core generation');
    const features = (await (await opened.store.prepare("SELECT value FROM meta WHERE key = 'features'")).get()) as { value: string } | undefined;
    if (!features) throw new Error('published index has no feature signature');
    const sources = (await (await opened.store.prepare('SELECT "path", text FROM indexed_sources ORDER BY "path"')).all()) as Array<{ path: string; text: string }>;
    return { generation: generation.value, features: features.value, sources };
  } finally {
    await opened.store.close();
  }
}

async function runOverlap(store: ParityStoreName): Promise<void> {
  const baseDir = scratchDir(`held-reader-${store}`);
  const configPath = join(baseDir, 'sense.config.json');
  const configBytes = JSON.stringify({ version: SUPPORTED_CONFIG_VERSION, store, presets: { default: { include: ['**/*.md'] } }, queries: {} });
  writeFileSync(configPath, configBytes);
  writeNote(baseDir, 'a.md', { body: 'old-a' });
  writeNote(baseDir, 'b.md', { body: 'old-b' });
  await withTreeForStore(store, baseDir, async ({ store: opened }) => {
    const baseline = await (await opened.prepare('SELECT "path", text FROM content WHERE "path" IN (?, ?) ORDER BY "path"')).all('a.md', 'b.md');
    assert.deepEqual(
      baseline,
      [
        { path: 'a.md', text: 'old-a' },
        { path: 'b.md', text: 'old-b' },
      ],
      `${store}: baseline`
    );
  });

  let writer: ProtocolChild | undefined;
  let reader: ProtocolChild | undefined;
  let bodyError: unknown;
  try {
    if (store === 'sqlite') {
      reader = startChild('reader', configPath);
      await reader.waitFor('ready');
      reader.send({ type: 'go' });
      await reader.waitFor('attempting');
      await reader.waitFor('open-launched');
      await reader.waitFor('open-ready');
      writer = startChild('writer', configPath);
      await writer.waitFor('held');
      reader.send({ type: 'probe' });
      const beforeRelease = await reader.waitFor('read-before-release');
      assert.deepEqual(
        beforeRelease.rows,
        [
          { path: 'a.md', text: 'old-a' },
          { path: 'b.md', text: 'old-b' },
        ],
        `${store}: reader must see the last committed snapshot while writer is held`
      );
    } else {
      writer = startChild('writer', configPath);
      reader = startChild('reader', configPath);
      await writer.waitFor('held');
      await reader.waitFor('ready');
      reader.send({ type: 'go' });
      await reader.waitFor('attempting');
      await reader.waitFor('open-launched');
      const locked = await reader.waitFor('lock-observed');
      assert.equal(locked.store, store, 'the real public open must encounter the held native lock');
      assert.equal(
        reader.messages.some((message) => message.type === 'open-ready'),
        false
      );
      assert.equal(
        writer.messages.some((message) => message.type === 'committed'),
        false
      );
    }
    assert.ok(writer && reader, `${store}: child processes must be started`);
    let beforeRelease: Message | undefined;
    if (store !== 'sqlite') {
      writer.send({ type: 'release' });
      await writer.waitFor('committed');
      await reader.waitFor('open-ready');
      reader.send({ type: 'probe' });
      beforeRelease = await reader.waitFor('read-before-release');
    } else {
      writer.send({ type: 'release' });
      await writer.waitFor('committed');
    }
    if (beforeRelease)
      assert.deepEqual(
        beforeRelease.rows,
        [
          { path: 'a.md', text: 'committed-a' },
          { path: 'b.md', text: 'committed-b' },
        ],
        `${store}: a blocked reader must see the complete committed snapshot`
      );
    reader.send({ type: 'release' });
    const read = await reader.waitFor('read');
    assert.deepEqual(
      read.rows,
      [
        { path: 'a.md', text: 'committed-a' },
        { path: 'b.md', text: 'committed-b' },
      ],
      `${store}: reader must see one complete committed snapshot`
    );
    await writer.waitFor('done');
    await reader.waitFor('done');
    await closeChild(writer);
    await closeChild(reader);
  } catch (err) {
    const detail = [writer?.stderr, reader?.stderr].filter(Boolean).join('\n');
    const reason = err instanceof Error ? err.message : String(err);
    bodyError = new Error(`${store}: held-writer reader proof failed: ${reason}${detail ? `; stderr=${detail}` : ''}`, { cause: err });
  }
  // allSettled so a cleanup failure (e.g. a raw taskkill error) never skips the other child's
  // cleanup, and never silently replaces a real body failure the way a throwing finally would.
  const cleanupResults = await Promise.allSettled([killChild(writer), killChild(reader)]);
  const cleanupErrors = cleanupResults.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason);
  if (bodyError && cleanupErrors.length > 0) throw new AggregateError([bodyError, ...cleanupErrors], `${store}: held-writer reader proof failed and cleanup also failed`);
  if (bodyError) throw bodyError;
  if (cleanupErrors.length > 0) throw cleanupErrors.length === 1 ? cleanupErrors[0] : new AggregateError(cleanupErrors, `${store}: held-writer reader cleanup failed`);

  assert.equal(readFileSync(configPath, 'utf8'), configBytes, `${store}: store overlap must leave the current config untouched`);

  await withTreeForStore(store, baseDir, async ({ store: opened }) => {
    const fresh = await (await opened.prepare('SELECT "path", text FROM content WHERE "path" IN (?, ?) ORDER BY "path"')).all('a.md', 'b.md');
    assert.deepEqual(
      fresh,
      [
        { path: 'a.md', text: 'committed-a' },
        { path: 'b.md', text: 'committed-b' },
      ],
      `${store}: fresh public read after commit`
    );
  });
}

async function runHeldReaderAcceptance(store: ParityStoreName): Promise<void> {
  const baseDir = scratchDir(`held-reader-acceptance-${store}`);
  const configPath = join(baseDir, 'sense.config.json');
  writeFileSync(configPath, JSON.stringify({ version: SUPPORTED_CONFIG_VERSION, store, presets: { default: { include: ['**/*.md'] } }, queries: {} }));
  writeNote(baseDir, 'a.md', { body: 'old-a' });
  writeNote(baseDir, 'b.md', { body: 'old-b' });
  const oldSources = [
    { path: 'a.md', text: '---\n\n---\n\nold-a\n' },
    { path: 'b.md', text: '---\n\n---\n\nold-b\n' },
  ];
  const committedSources = [
    { path: 'a.md', text: 'committed-a' },
    { path: 'b.md', text: 'committed-b' },
  ];
  await withTreeForStore(store, baseDir, async () => {});

  let firstReader: ProtocolChild | undefined;
  let secondReader: ProtocolChild | undefined;
  let writer: ProtocolChild | undefined;
  let stage = 'initial';
  try {
    // Leg one: establish reader/reader overlap (or native contention), then drain both
    // readers before testing writer acquisition so DuckDB/Turso cannot race the waiters.
    stage = 'leg1-first-reader-start';
    firstReader = startChild('reader2', configPath);
    await firstReader.waitFor('ready');
    firstReader.send({ type: 'go' });
    await firstReader.waitFor('open-ready');
    firstReader.send({ type: 'probe' });
    await firstReader.waitFor('read-before-release');

    stage = 'leg1-second-reader-attempt';
    secondReader = startChild('reader2', configPath);
    await secondReader.waitFor('ready');
    secondReader.send({ type: 'go' });
    await secondReader.waitFor('attempting');
    const secondOutcome = await waitForAny(secondReader, ['open-ready', 'lock-observed']);
    const secondLocked = secondOutcome.type === 'lock-observed';
    if (store === 'sqlite') assert.equal(secondLocked, false, `${store}: observational readers must coexist`);
    stage = 'leg1-release-readers';
    firstReader.send({ type: 'release' });
    await firstReader.waitFor('read');
    if (secondLocked) await secondReader.waitFor('open-ready');
    secondReader.send({ type: 'probe' });
    await secondReader.waitFor('read-before-release');
    secondReader.send({ type: 'release' });
    await secondReader.waitFor('read');
    await Promise.all([closeChild(firstReader), closeChild(secondReader)]);

    // Leg two: hold a fresh reader while the writer actually attempts its open.
    stage = 'leg2-fresh-reader-start';
    firstReader = startChild('reader2', configPath);
    await firstReader.waitFor('ready');
    firstReader.send({ type: 'go' });
    await firstReader.waitFor('open-ready');
    stage = 'leg2-writer-attempt';
    writer = startChild('writer', configPath);
    await writer.waitFor('open-launched');
    const writerOutcome = await waitForAny(writer, ['held', 'lock-observed']);
    const writerLocked = writerOutcome.type === 'lock-observed';
    firstReader.send({ type: 'probe' });
    const beforeCommit = await firstReader.waitFor('read-before-release');
    if (!writerLocked) {
      if (store === 'sqlite') {
        assert.deepEqual(
          beforeCommit.rows,
          [
            { path: 'a.md', text: 'old-a' },
            { path: 'b.md', text: 'old-b' },
          ],
          `${store}: reader sees committed state during held writer transaction`
        );
        assert.deepEqual(beforeCommit.snippets, oldSources, `${store}: snippets remain committed during held writer transaction`);
      }
    }
    if (store === 'sqlite') assert.equal(writerLocked, false, `${store}: writer must reach its transaction`);
    stage = 'leg2-release-reader';
    firstReader.send({ type: 'release' });
    await firstReader.waitFor('read');
    if (writerLocked) await writer.waitFor('held');
    writer.send({ type: 'release' });
    await writer.waitFor('committed');
    await writer.waitFor('done');

    stage = 'post-commit-reopen';
    secondReader = startChild('reader2', configPath);
    await secondReader.waitFor('ready');
    secondReader.send({ type: 'go' });
    await secondReader.waitFor('open-ready');
    secondReader.send({ type: 'probe' });
    const committed = await secondReader.waitFor('read-before-release');
    assert.deepEqual(
      committed.rows,
      [
        { path: 'a.md', text: 'committed-a' },
        { path: 'b.md', text: 'committed-b' },
      ],
      `${store}: reopened reader must see committed authored text and indexed snippet source`
    );
    assert.deepEqual(committed.snippets, committedSources, `${store}: reopened reader must see committed stored snippets`);
    secondReader.send({ type: 'release' });
    await secondReader.waitFor('read');
    await Promise.all([closeChild(firstReader), closeChild(secondReader), closeChild(writer)]);
  } catch (err) {
    const snapshot = (child: ProtocolChild | undefined) => (child ? JSON.stringify(child.messages) : 'not-started');
    throw new Error(`${store}: acceptance failed at ${stage}; first=${snapshot(firstReader)}; second=${snapshot(secondReader)}; writer=${snapshot(writer)}`, { cause: err });
  } finally {
    await Promise.all([killChild(firstReader), killChild(secondReader), killChild(writer)]);
  }
}

describe('bounded core publication', () => {
  it('keeps the committed generation readable while a no-op builder is active', async function () {
    this.timeout(60_000);
    const rootDir = scratchDir('active-noop-root');
    const configDir = scratchDir('active-noop-config');
    const { configPath, cfg } = writeSqliteConfig(configDir, 'sense.config.json', rootDir);
    const releasePath = join(configDir, 'release-noop');
    writeNote(rootDir, 'a.md', { body: 'last committed content' });
    await build(cfg);
    const before = await publishedState(cfg);

    let builder: ProtocolChild | undefined;
    let bodyFailed = false;
    let bodyError: unknown;
    try {
      builder = startChild('builder', configPath, releasePath, 'noop');
      const planned = await builder.waitFor('planned');
      assert.equal(planned.attempt, 0);
      assert.equal(planned.generation, before.generation);
      assert.deepEqual(await publishedState(cfg), before, 'an active planner withdrew the published generation');

      writeFileSync(releasePath, 'release');
      const built = await builder.waitFor('built');
      assert.equal(built.parsed, 0);
      await builder.waitFor('done');
      await closeChild(builder);
      assert.deepEqual(await publishedState(cfg), before, 'a no-op build advanced or changed the published generation');
    } catch (err) {
      bodyFailed = true;
      bodyError = err;
    }
    await finishChildren([builder], bodyFailed, bodyError, 'active no-op publication proof');
  });

  it('publishes one watcher generation while a semantic query and no-op builder are gated', async function () {
    this.timeout(90_000);
    const queryInput = 'mixedqueryanchor';
    const oldBody = `${queryInput} old authored snippet`;
    const newBody = `${queryInput} new generation authored snippet`;
    const baseDir = scratchDir('mixed-client-sqlite');
    const configPath = join(baseDir, 'sense.config.json');
    const releasePath = join(baseDir, 'release-mixed-builder');
    const provider = await controlledMixedClientProvider(queryInput);

    type SearchRows = Awaited<ReturnType<typeof search>>;
    let watcher: ReturnType<typeof startMeasuredWatcher> | undefined;
    let builder: ProtocolChild | undefined;
    let queryOpened: Awaited<ReturnType<typeof open>> | undefined;
    let queryOutcome: Promise<PromiseSettledResult<SearchRows>> | undefined;
    let querySettled = false;
    let queryOutcomeConsumed = false;
    let builderGateObserved = false;
    let builderOutcomeObserved = false;
    let bodyFailed = false;
    let bodyError: unknown;
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          version: SUPPORTED_CONFIG_VERSION,
          store: 'sqlite',
          presets: { default: { include: ['**/*.md'], signals: { words: 1, vectors: 1 } } },
          embed: { provider: 'openai', model: 'mixed-client-protocol-fixture', url: provider.endpoint },
          queries: {},
        })
      );
      const cfg = loadConfig(configPath);
      writeNote(baseDir, 'a.md', { body: oldBody });
      await build(cfg);
      assert.equal(await pendingVectorCount(cfg), 0, 'initial vectors must be ready before watcher startup');

      // Force one known startup reparse, then consume its post-start event before defining G0.
      // This separates buffered startup output from the later authored edit without relying on
      // native notification timing; the edit wait below still permits the shipped fallback pass.
      const startupMtime = new Date(Date.now() + 60_000);
      utimesSync(join(baseDir, 'a.md'), startupMtime, startupMtime);
      const activeWatcher = startMeasuredWatcher({ pkgRoot: packageRoot, configPath });
      watcher = activeWatcher;
      const started = await activeWatcher.waitFor('started', 0, DEADLINE_MS);
      const startupReconciled = await activeWatcher.waitFor('reconciled', started.next, WATCH_HEARTBEAT_INTERVAL_MS + DEADLINE_MS);
      assert.deepEqual({ parsed: startupReconciled.event.parsed, total: startupReconciled.event.total, warnings: startupReconciled.event.warnings }, { parsed: 1, total: 1, warnings: [] }, 'watcher did not report the forced baseline startup reparse');
      assert.equal(await pendingVectorCount(cfg), 0, 'startup reconciliation did not leave baseline vectors ready');
      const before = await publishedState(cfg);
      assert.deepEqual(before.sources, [{ path: 'a.md', text: `---\n\n---\n\n${oldBody}\n` }]);

      const activeQuery = await open(cfg, { build: false });
      queryOpened = activeQuery;
      const queryOperation = search(activeQuery.store, cfg, queryInput, { k: 1 });
      const observedQueryOutcome = Promise.allSettled([queryOperation]).then(([outcome]) => {
        querySettled = true;
        return outcome;
      });
      queryOutcome = observedQueryOutcome;
      const queryStart = await Promise.race([provider.queryStarted.then(() => ({ type: 'started' as const })), observedQueryOutcome.then((outcome) => ({ type: 'settled' as const, outcome }))]);
      if (queryStart.type === 'settled') {
        queryOutcomeConsumed = true;
        if (queryStart.outcome.status === 'rejected') throw queryStart.outcome.reason;
        throw new Error('semantic query settled before its uniquely authored provider input was held');
      }

      const activeBuilder = startChild('builder', configPath, releasePath, 'mixed-noop');
      builder = activeBuilder;
      const firstPlan = await activeBuilder.waitFor('planned');
      builderGateObserved = true;
      assert.equal(firstPlan.attempt, 0);
      assert.equal(firstPlan.generation, before.generation);
      assert.equal(firstPlan.wantedSignature, before.features);

      const editDeadline = Date.now() + WATCH_HEARTBEAT_INTERVAL_MS + DEADLINE_MS;
      let editCursor = activeWatcher.events.length;
      writeNote(baseDir, 'a.md', { body: newBody });
      let reconciled: Awaited<ReturnType<typeof activeWatcher.waitFor>>;
      for (;;) {
        const remainingMs = editDeadline - Date.now();
        if (remainingMs <= 0) throw new Error('watcher produced no authored edit reconciliation before the fallback-aware deadline');
        const event = await activeWatcher.waitFor('reconciled', editCursor, remainingMs);
        editCursor = event.next;
        if (event.event.parsed === 0) continue;
        reconciled = event;
        break;
      }
      assert.deepEqual({ parsed: reconciled.event.parsed, total: reconciled.event.total, warnings: reconciled.event.warnings }, { parsed: 1, total: 1, warnings: [] }, 'watcher did not publish the one authored edit');

      assert.equal(provider.queryReleased, false, 'watcher publication released the held semantic query');
      assert.equal(querySettled, false, 'semantic query settled before the watcher publication oracle');
      assert.equal(existsSync(releasePath), false, 'watcher publication released the no-op builder gate');
      assert.equal(
        activeBuilder.messages.some((message) => message.type === 'built' || (message.type === 'planned' && message.attempt === 1)),
        false,
        'the no-op builder advanced past its attempt-0 gate before watcher publication'
      );
      assert.equal(activeBuilder.child.exitCode, null, 'the gated builder exited before watcher publication');
      assert.equal(activeBuilder.child.signalCode, null, 'the gated builder received a signal before watcher publication');

      const published = await publishedState(cfg);
      assert.equal(Number(published.generation), Number(before.generation) + 1, 'watcher must publish exactly one new core generation');
      assert.equal(published.features, before.features);
      assert.deepEqual(published.sources, [{ path: 'a.md', text: `---\n\n---\n\n${newBody}\n` }], 'watcher generation did not publish the authored indexed bytes');
      assert.equal(await pendingVectorCount(cfg), 0, 'watcher event preceded vector readiness for the published generation');

      writeFileSync(releasePath, 'release');
      const built = await activeBuilder.waitFor('built');
      assert.equal(built.parsed, 0, 'stale no-op builder reparsed the watcher generation');
      await activeBuilder.waitFor('done');
      builderOutcomeObserved = true;
      const plans = activeBuilder.messages.filter((message) => message.type === 'planned');
      assert.deepEqual(
        plans.map((message) => ({ attempt: message.attempt, generation: message.generation })),
        [
          { attempt: 0, generation: before.generation },
          { attempt: 1, generation: published.generation },
        ],
        'no-op builder did not replan exactly once from the watcher generation'
      );
      assert.ok(
        plans.every((plan) => plan.wantedSignature === before.features),
        'bounded replan changed the configured feature signature'
      );
      const afterBuilder = await publishedState(cfg);
      assert.equal(afterBuilder.generation, published.generation, 'replanned no-op builder advanced the watcher generation');
      assert.deepEqual(afterBuilder.sources, published.sources);

      provider.releaseQuery();
      const completedQuery = await observedQueryOutcome;
      queryOutcomeConsumed = true;
      if (completedQuery.status === 'rejected') throw completedQuery.reason;
      assert.deepEqual(
        completedQuery.value.map((row) => row.path),
        ['a.md'],
        'prepared semantic query did not return the authored watcher path'
      );
      const snippets = completedQuery.value.flatMap((row) => row.snippets);
      const unmarked = snippets.map((snippet) => snippet.replaceAll(/[«»]/g, ''));
      assert.ok(
        unmarked.some((snippet) => snippet.includes(newBody)),
        JSON.stringify(completedQuery.value)
      );
      assert.ok(
        unmarked.every((snippet) => !snippet.includes(oldBody)),
        'prepared query hydrated snippet bytes from the superseded generation'
      );
      assert.equal(provider.queryRequests, 1, 'fixture held something other than the one uniquely authored query request');

      const finalState = await publishedState(cfg);
      assert.equal(Number(finalState.generation), Number(before.generation) + 1);
      assert.deepEqual(finalState.sources, [{ path: 'a.md', text: `---\n\n---\n\n${newBody}\n` }]);
    } catch (err) {
      bodyFailed = true;
      bodyError = err;
    }

    const cleanupErrors: unknown[] = [];
    try {
      if (!existsSync(releasePath)) writeFileSync(releasePath, 'release');
    } catch (err) {
      cleanupErrors.push(err);
    }
    try {
      provider.releaseQuery();
    } catch (err) {
      cleanupErrors.push(err);
    }

    const gateCleanup: Array<Promise<void>> = [];
    if (queryOutcome && !queryOutcomeConsumed) {
      gateCleanup.push(
        queryOutcome.then((outcome) => {
          queryOutcomeConsumed = true;
          if (outcome.status === 'rejected') throw outcome.reason;
        })
      );
    }
    if (builder && builderGateObserved && !builderOutcomeObserved) {
      gateCleanup.push(
        builder.waitFor('done').then(() => {
          builderOutcomeObserved = true;
        })
      );
    }
    const gateResults = await Promise.allSettled(gateCleanup);
    cleanupErrors.push(...gateResults.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason));

    const resourceCleanup = await Promise.allSettled([
      Promise.resolve().then(() => (queryOpened ? queryOpened.store.close() : undefined)),
      Promise.resolve().then(() => (watcher ? watcher.close(DEADLINE_MS) : undefined)),
      Promise.resolve().then(() => (builder && builderOutcomeObserved ? closeChild(builder) : killChild(builder))),
      closeServer(provider.server),
    ]);
    cleanupErrors.push(...resourceCleanup.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason));
    if (bodyFailed && cleanupErrors.length > 0) throw new AggregateError([bodyError, ...cleanupErrors], 'mixed-client acceptance and cleanup both failed');
    if (bodyFailed) throw bodyError;
    if (cleanupErrors.length > 0) throw cleanupErrors.length === 1 ? cleanupErrors[0] : new AggregateError(cleanupErrors, 'mixed-client acceptance cleanup failed');
  });

  it('replans one of two same-signature builders and publishes the edit once', async function () {
    this.timeout(60_000);
    const rootDir = scratchDir('same-signature-root');
    const configDir = scratchDir('same-signature-config');
    const { configPath, cfg } = writeSqliteConfig(configDir, 'sense.config.json', rootDir);
    const releaseA = join(configDir, 'release-a');
    const releaseB = join(configDir, 'release-b');
    writeNote(rootDir, 'a.md', { body: 'initial content' });
    await build(cfg);
    const before = await publishedState(cfg);
    writeNote(rootDir, 'a.md', { body: 'published once' });

    let first: ProtocolChild | undefined;
    let second: ProtocolChild | undefined;
    let bodyFailed = false;
    let bodyError: unknown;
    try {
      first = startChild('builder', configPath, releaseA, 'first');
      second = startChild('builder', configPath, releaseB, 'second');
      const [firstPlan, secondPlan] = await Promise.all([first.waitFor('planned'), second.waitFor('planned')]);
      assert.equal(firstPlan.generation, before.generation);
      assert.equal(secondPlan.generation, before.generation);

      writeFileSync(releaseA, 'release');
      writeFileSync(releaseB, 'release');
      const [firstBuilt, secondBuilt] = await Promise.all([first.waitFor('built'), second.waitFor('built')]);
      await Promise.all([first.waitFor('done'), second.waitFor('done')]);
      assert.deepEqual(
        [firstBuilt.parsed, secondBuilt.parsed].sort((a, b) => (a ?? -1) - (b ?? -1)),
        [0, 1],
        'the stale same-signature plan was not replanned against the committed edit'
      );
      const replans = [...first.messages, ...second.messages].filter((message) => message.type === 'planned' && message.attempt === 1);
      assert.equal(replans.length, 1, 'exactly one stale plan must use the bounded replan');
      await Promise.all([closeChild(first), closeChild(second)]);

      const after = await publishedState(cfg);
      assert.equal(Number(after.generation), Number(before.generation) + 1, 'same content was published as more than one core generation');
      assert.deepEqual(after.sources, [{ path: 'a.md', text: '---\n\n---\n\npublished once\n' }]);
    } catch (err) {
      bodyFailed = true;
      bodyError = err;
    }
    await finishChildren([first, second], bodyFailed, bodyError, 'same-signature publication proof');
  });

  it('replans a stale different-config builder without stamping its old plan', async function () {
    this.timeout(60_000);
    const configDir = scratchDir('different-config-cache');
    const rootA = scratchDir('different-config-a');
    const rootB = scratchDir('different-config-b');
    const a = writeSqliteConfig(configDir, 'a.config.json', rootA);
    const b = writeSqliteConfig(configDir, 'b.config.json', rootB);
    const releaseA = join(configDir, 'release-a');
    const releaseB = join(configDir, 'release-b');
    writeNote(rootA, 'a.md', { body: 'a before race' });
    writeNote(rootB, 'b.md', { body: 'b configured tree' });
    await build(a.cfg);
    const before = await publishedState(a.cfg);
    writeNote(rootA, 'a.md', { body: 'a configured tree' });

    let first: ProtocolChild | undefined;
    let second: ProtocolChild | undefined;
    let bodyFailed = false;
    let bodyError: unknown;
    try {
      first = startChild('builder', a.configPath, releaseA, 'a');
      second = startChild('builder', b.configPath, releaseB, 'b');
      const [firstPlan, secondPlan] = await Promise.all([first.waitFor('planned'), second.waitFor('planned')]);
      assert.equal(firstPlan.generation, before.generation);
      assert.equal(secondPlan.generation, before.generation);
      assert.notEqual(firstPlan.wantedSignature, secondPlan.wantedSignature, 'the fixture must submit different durable configurations');

      writeFileSync(releaseA, 'release');
      writeFileSync(releaseB, 'release');
      const [firstBuilt, secondBuilt] = await Promise.all([first.waitFor('built'), second.waitFor('built')]);
      await Promise.all([first.waitFor('done'), second.waitFor('done')]);
      assert.deepEqual([firstBuilt.parsed, secondBuilt.parsed], [1, 1]);
      const replans = [...first.messages, ...second.messages].filter((message) => message.type === 'planned' && message.attempt === 1);
      assert.equal(replans.length, 1, 'exactly one different-config plan must be rejected and replanned');
      const finalLabel = replans[0].label;
      assert.ok(finalLabel === 'a' || finalLabel === 'b');
      await Promise.all([closeChild(first), closeChild(second)]);

      const finalCfg = finalLabel === 'a' ? a.cfg : b.cfg;
      const staleCfg = finalLabel === 'a' ? b.cfg : a.cfg;
      const finalState = await publishedState(finalCfg);
      assert.equal(Number(finalState.generation), Number(before.generation) + 2, 'both distinct core publications must advance the generation');
      assert.deepEqual(finalState.sources, finalLabel === 'a' ? [{ path: 'a.md', text: '---\n\n---\n\na configured tree\n' }] : [{ path: 'b.md', text: '---\n\n---\n\nb configured tree\n' }], 'the final signature was stamped over rows from the stale configuration plan');
      await assert.rejects(async () => {
        const unexpected = await open(staleCfg, { build: false });
        try {
          throw new Error('the superseded configuration unexpectedly opened the final generation');
        } finally {
          await unexpected.store.close();
        }
      }, /built for different configuration features/);
    } catch (err) {
      bodyFailed = true;
      bodyError = err;
    }
    await finishChildren([first, second], bodyFailed, bodyError, 'different-config publication proof');
  });

  it('replans when local model identity changes after planning', async function () {
    this.timeout(60_000);
    const rootDir = scratchDir('model-identity-root');
    const configDir = scratchDir('model-identity-config');
    const model = writeModel();
    const configPath = join(configDir, 'sense.config.json');
    const releasePath = join(configDir, 'release-model-identity');
    writeFileSync(
      configPath,
      JSON.stringify({
        version: SUPPORTED_CONFIG_VERSION,
        root: rootDir,
        store: 'sqlite',
        presets: { default: { include: ['**/*.md'], signals: { words: 1 } } },
        embed: { provider: 'static', model },
        queries: {},
      })
    );
    const cfg = loadConfig(configPath);
    writeNote(rootDir, 'a.md', { body: 'local identity content' });
    await build(cfg);
    const before = await publishedState(cfg);

    let builder: ProtocolChild | undefined;
    let bodyFailed = false;
    let bodyError: unknown;
    try {
      builder = startChild('builder', configPath, releasePath, 'model-identity');
      const planned = await builder.waitFor('planned');
      assert.equal(planned.attempt, 0);
      assert.equal(planned.wantedSignature, before.features);

      const changedTime = new Date(Date.now() + 60_000);
      utimesSync(join(model, 'model.safetensors'), changedTime, changedTime);
      writeFileSync(releasePath, 'release');

      const built = await builder.waitFor('built');
      assert.equal(built.parsed, 1, 'the identity-only replan must rebuild against the changed local model metadata');
      await builder.waitFor('done');
      const plans = builder.messages.filter((message) => message.type === 'planned');
      assert.deepEqual(
        plans.map((message) => message.attempt),
        [0, 1],
        'the stale identity plan must take exactly the bounded replan'
      );
      assert.notEqual(plans[0].wantedSignature, plans[1].wantedSignature, 'the real local model metadata change must alter the durable signature');
      await closeChild(builder);

      const after = await publishedState(cfg);
      assert.equal(after.features, plans[1].wantedSignature, 'publication stamped a stale planned model identity');
      assert.notEqual(after.features, plans[0].wantedSignature, 'publication retained the signature planned before model metadata changed');
      assert.equal(Number(after.generation), Number(before.generation) + 1);
      assert.deepEqual(after.sources, before.sources);
    } catch (err) {
      bodyFailed = true;
      bodyError = err;
    }
    await finishChildren([builder], bodyFailed, bodyError, 'local model identity publication proof');
  });
});

describe('held writer and independent reader', () => {
  it('publishes one authored config after both processes read the same legacy input', async function () {
    this.timeout(90_000);
    await runSameInputMigration();
  });

  it('keeps lexical candidates and indexed snippet bytes in one committed generation', async function () {
    this.timeout(60_000);
    await runSearchSnapshotOverlap();
  });

  it('records concurrent reader and writer access while the first reader is held', async function () {
    this.timeout(60_000);
    await forEachStore(runHeldReaderAcceptance);
  });

  it('never exposes partial state or a raw native lock failure', async function () {
    this.timeout(90_000);
    await forEachStore(runOverlap);
  });

  it('keeps the production heartbeat live through a held first reconcile and expires it after a crash', async function () {
    this.timeout(60_000);
    const baseDir = scratchDir('watch-held-reconcile');
    const configPath = join(baseDir, 'sense.config.json');
    writeFileSync(configPath, JSON.stringify({ version: SUPPORTED_CONFIG_VERSION, store: 'sqlite', presets: { default: { include: ['**/*.md'] } }, queries: {} }));
    writeNote(baseDir, 'a.md', { body: 'old-a' });
    writeNote(baseDir, 'b.md', { body: 'old-b' });
    await withTreeForStore('sqlite', baseDir, async () => {});

    let writer: ProtocolChild | undefined;
    let watcher: ReturnType<typeof startMeasuredWatcher> | undefined;
    let contender: ReturnType<typeof startMeasuredWatcher> | undefined;
    let replacement: ReturnType<typeof startMeasuredWatcher> | undefined;
    try {
      writer = startChild('writer', configPath);
      await writer.waitFor('held');
      writeNote(baseDir, 'a.md', { body: 'reconcile waits for the held writer' });
      watcher = startMeasuredWatcher({ pkgRoot: packageRoot, configPath });
      const firstClaim = await waitForClaim(baseDir, () => true);
      const liveClaim = await waitForClaim(baseDir, (claim) => claim.token === firstClaim.token && claim.heartbeatMs > firstClaim.heartbeatMs && Date.now() - firstClaim.heartbeatMs >= WATCH_STALE_HEARTBEAT_MS && Date.now() - claim.heartbeatMs < 2 * WATCH_HEARTBEAT_INTERVAL_MS, WATCH_STALE_HEARTBEAT_MS + DEADLINE_MS);
      assert.equal(
        watcher.events.some((event) => event.type === 'started'),
        false,
        'the watcher must still be inside the held initial reconcile'
      );
      watcher.assertRunning();
      assert.equal(writer.child.exitCode, null, 'the held writer must still be running before release');
      assert.equal(writer.child.signalCode, null, 'the held writer must not receive a signal before release');
      assert.equal(
        writer.messages.some((message) => ['error', 'committed', 'done'].includes(message.type)),
        false,
        'the held writer must neither fail nor settle before release'
      );

      contender = startMeasuredWatcher({ pkgRoot: packageRoot, configPath });
      const rejected = await contender.waitFor('run-watch-rejected', 0, DEADLINE_MS);
      assert.equal(rejected.event.error.code, 'WATCH_ACTIVE');
      await contender.close(5_000, 'WATCH_ACTIVE');

      writer.send({ type: 'release' });
      await writer.waitFor('committed');
      await watcher.waitFor('started', 0, DEADLINE_MS);
      await closeChild(writer);

      signalProcessTree(watcher.child, 'SIGKILL');
      const crashed = await watcher.closed;
      assert.notDeepEqual({ code: crashed.code, signal: crashed.signal }, { code: 0, signal: null }, 'the owner must be terminated rather than shut down cleanly');
      const stoppedClaim = readWatchClaim(baseDir);
      assert.equal(stoppedClaim?.token, liveClaim.token);
      await waitForClaim(baseDir, (claim) => claim.token === liveClaim.token && Date.now() - claim.heartbeatMs >= WATCH_STALE_HEARTBEAT_MS, WATCH_STALE_HEARTBEAT_MS + 5_000);

      replacement = startMeasuredWatcher({ pkgRoot: packageRoot, configPath });
      await replacement.waitFor('started', 0, DEADLINE_MS);
      await replacement.close(5_000);
    } finally {
      await Promise.all([killChild(writer), killMeasuredWatcher(watcher), killMeasuredWatcher(contender), killMeasuredWatcher(replacement)]);
    }
  });
});
