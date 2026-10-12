import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Connection, OpenDialect } from '../../src/store/types.ts';
import { jobProblems, spawnOwned } from './step-process.ts';
import type { AuthoredContent, FileManifestEntry } from './work-tree.ts';
import { indexSnapshotMismatch, readIndexSnapshot } from './work-tree.ts';

type Dialect = Pick<OpenDialect<unknown>, 'filename' | 'connect' | 'close' | 'isLocked'>;
interface LexicalInput {
  terms: string;
  limit: number;
  expected_paths: string[];
}
interface ObserverInput {
  pkgRoot: string;
  store: string;
  configPath: string;
  manifest: readonly FileManifestEntry[];
  expectedContent?: [string, string][] | null;
  authoredContent?: [string, AuthoredContent][] | null;
  lexical?: LexicalInput;
}
interface Timings {
  connect_ms?: number;
  snapshot_ms?: number;
  close_ms?: number;
}
interface ObserverResult {
  state?: string;
  timings?: Timings;
  paths?: number;
  fingerprint?: string;
  mismatch?: string | null;
  content?: [string, string][];
  lexical?: { state?: string; indexed_docs?: number; indexed_paths?: unknown[]; paths?: unknown[] };
}
interface ErrorDetails {
  message?: unknown;
  stack?: unknown;
  code?: unknown;
}

const DIALECT_EXPORT: Record<string, string | undefined> = { sqlite: 'sqliteOpenDialect', duckdb: 'duckdbOpenDialect', turso: 'tursoOpenDialect' };
const POLL_MS = 25;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const elapsedMs = (started: bigint) => Number(process.hrtime.bigint() - started) / 1e6;

async function observeDuckdbLexical(conn: Connection, lexical: LexicalInput) {
  await conn.exec('INSTALL fts; LOAD fts;');
  const docsStatement = await conn.prepare('SELECT name FROM fts_main_content.docs ORDER BY name');
  const docsRows = (await docsStatement.all()) as { name: unknown }[];
  const indexedPaths = docsRows.map((row) => row.name);
  const indexedDocs = indexedPaths.length;
  if (indexedPaths.some((path) => typeof path !== 'string') || new Set(indexedPaths).size !== indexedDocs) throw new Error('DuckDB FTS docs returned malformed or duplicate paths');
  const matchStatement = await conn.prepare(`SELECT path FROM (
    SELECT content."path" AS path, fts_main_content.match_bm25(content."path", ?, conjunctive := true) AS score
    FROM content
  ) matches WHERE score IS NOT NULL ORDER BY score DESC, path LIMIT ?`);
  const rows = (await matchStatement.all(lexical.terms, lexical.limit)) as { path: unknown }[];
  const paths = rows.map((row) => row.path);
  return { state: 'ready', indexed_docs: indexedDocs, indexed_paths: indexedPaths, paths };
}

export async function observeNativeIndex({ pkgRoot, store, configPath, manifest, expectedContent = null, authoredContent = null, lexical = null }: Omit<ObserverInput, 'lexical'> & { lexical?: LexicalInput | null }) {
  const exportName = DIALECT_EXPORT[store];
  if (!exportName) throw new Error(`native observer has no dialect mapping for store ${JSON.stringify(store)}`);
  const moduleUrl = pathToFileURL(resolve(pkgRoot, 'dist', 'esm', 'store', store, 'open.js')).href;
  const publicUrl = pathToFileURL(resolve(pkgRoot, 'dist', 'esm', 'index.js')).href;
  let dialect: Dialect | undefined;
  let loadConfig: typeof import('../../src/index.ts')['loadConfig'] | undefined;
  try {
    dialect = (await import(moduleUrl))[exportName];
    ({ loadConfig } = await import(publicUrl));
  } catch (err) {
    throw new Error(`native observer could not import ${moduleUrl}: ${(err as ErrorDetails | null | undefined)?.message ?? err}`);
  }
  if (!dialect?.connect || !dialect?.close || !dialect.filename) throw new Error(`native observer ${moduleUrl} has no ${exportName} connect/close seam`);
  if (typeof loadConfig !== 'function') throw new Error(`native observer ${publicUrl} has no loadConfig export`);
  const cfg = loadConfig(configPath);

  const timings: Timings = {};
  let connected: Awaited<ReturnType<Dialect['connect']>> | undefined;
  let result: ObserverResult | undefined;
  let operationError: unknown;
  try {
    const connectStarted = process.hrtime.bigint();
    try {
      connected = await dialect.connect(resolve(cfg.configDir ?? cfg.baseDir, '.sense', dialect.filename), cfg, { existingOnly: true, observational: true });
    } catch (err) {
      timings.connect_ms = elapsedMs(connectStarted);
      if (dialect.isLocked?.(err as Error)) result = { state: 'locked', timings };
      else operationError = err;
    }
    if (connected) {
      timings.connect_ms = elapsedMs(connectStarted);
      const snapshotStarted = process.hrtime.bigint();
      const snapshot = await readIndexSnapshot(connected.conn);
      timings.snapshot_ms = elapsedMs(snapshotStarted);
      const content = new Map(expectedContent ?? []);
      const mismatch = indexSnapshotMismatch(snapshot, manifest, expectedContent === null ? null : content);
      if (!mismatch && authoredContent !== null) await readIndexSnapshot(connected.conn, { expectedContent: new Map(authoredContent) });
      let lexicalObservation = null;
      if (!mismatch && lexical !== null && store === 'duckdb') lexicalObservation = await observeDuckdbLexical(connected.conn, lexical);
      result = { state: mismatch ? 'stale' : 'ready', mismatch, fingerprint: snapshot.fingerprint, content: expectedContent === null ? [...snapshot.content] : undefined, paths: snapshot.metadata.size, ...(lexicalObservation ? { lexical: lexicalObservation } : {}), timings };
    }
  } catch (err) {
    operationError = err;
  }

  let closeError: unknown;
  if (connected) {
    const closeStarted = process.hrtime.bigint();
    try {
      await dialect.close(connected.handle, { observational: true });
      timings.close_ms = elapsedMs(closeStarted);
    } catch (err) {
      closeError = err;
    }
  }
  if (operationError || closeError) {
    const messages = [operationError && `operation: ${(operationError as ErrorDetails | null | undefined)?.stack ?? operationError}`, closeError && `close: ${(closeError as ErrorDetails | null | undefined)?.stack ?? closeError}`].filter(Boolean);
    throw new Error(`native observer failed (${messages.join('; ')})`);
  }
  return result;
}

async function childMain() {
  const send = process.send?.bind(process);
  if (!send) throw new Error('native observer child requires an IPC supervisor');
  let completed = false;
  process.once('disconnect', () => {
    if (!completed) {
      process.stderr.write('native observer lost its supervisor; result invalid\n');
      process.exit(70);
    }
  });
  try {
    const inputPromise = new Promise<unknown>((resolveInput, rejectInput) => {
      process.once('message', resolveInput);
      process.once('error', rejectInput);
    });
    await new Promise<void>((resolveReady, rejectReady) => send({ type: 'supervised' }, (err) => (err ? rejectReady(err) : resolveReady())));
    const input = await inputPromise;
    if (typeof input !== 'string') throw new Error('native observer received a non-string payload');
    const result = await observeNativeIndex(JSON.parse(input));
    await new Promise<void>((resolveWrite, rejectWrite) => process.stdout.write(`${JSON.stringify(result)}\n`, (err) => (err ? rejectWrite(err) : resolveWrite())));
  } catch (err) {
    process.stderr.write(`${(err as ErrorDetails | null | undefined)?.stack ?? err}\n`);
    process.exitCode = 1;
  } finally {
    completed = true;
    if (process.connected) process.disconnect();
  }
}

function validTiming(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validateResult(result: ObserverResult, payload: ObserverInput) {
  const expectsContent = payload.expectedContent != null;
  if (!['ready', 'stale', 'locked'].includes(result?.state as string)) throw new Error(`invalid state ${JSON.stringify(result?.state)}`);
  if (!result.timings || !validTiming(result.timings.connect_ms)) throw new Error('missing finite connect timing');
  if (result.state === 'locked') return result;
  if (!validTiming(result.timings.snapshot_ms) || !validTiming(result.timings.close_ms)) throw new Error('missing finite snapshot/close timing');
  if (!Number.isInteger(result.paths) || (result.paths as number) < 0) throw new Error(`invalid path count ${JSON.stringify(result.paths)}`);
  if (!/^[0-9a-f]{64}$/.test(result.fingerprint as string)) throw new Error(`invalid fingerprint ${JSON.stringify(result.fingerprint)}`);
  if (result.state === 'ready' && result.paths !== payload.manifest.length) throw new Error(`ready path count mismatch: expected ${payload.manifest.length}, got ${result.paths}`);
  if (result.state === 'ready' && result.mismatch !== null && result.mismatch !== undefined) throw new Error(`ready result has a mismatch: ${JSON.stringify(result.mismatch)}`);
  if (result.state === 'stale' && (typeof result.mismatch !== 'string' || result.mismatch.length === 0)) throw new Error('stale result has no mismatch');
  if (payload.lexical !== undefined && result.state === 'ready') {
    if (payload.store !== 'duckdb') throw new Error(`lexical native observation is only implemented for duckdb, not ${payload.store}`);
    const observation = result.lexical;
    if (!observation || observation.state !== 'ready' || observation.indexed_docs !== payload.manifest.length) throw new Error('DuckDB lexical index is not ready for the measured content');
    const expectedIndexedPaths = payload.manifest.map((entry) => entry.rel).sort();
    const actualIndexedPaths = Array.isArray(observation.indexed_paths) ? observation.indexed_paths.filter((path) => typeof path === 'string').sort() : [];
    if (!Array.isArray(observation.indexed_paths) || actualIndexedPaths.length !== observation.indexed_paths.length || actualIndexedPaths.join('\0') !== expectedIndexedPaths.join('\0'))
      throw new Error(`DuckDB lexical index paths mismatch: expected ${JSON.stringify(expectedIndexedPaths)}, got ${JSON.stringify(observation.indexed_paths)}`);
    if (!Array.isArray(observation.paths) || observation.paths.some((path) => typeof path !== 'string')) throw new Error('DuckDB lexical observation returned malformed paths');
    const expectedPaths = payload.lexical.expected_paths;
    if (expectedPaths.some((path) => !(observation.paths as unknown[]).includes(path))) throw new Error(`DuckDB lexical result omitted a public result path: expected ${JSON.stringify(expectedPaths)}, got ${JSON.stringify(observation.paths)}`);
  }
  if (expectsContent) {
    if (result.content !== undefined) throw new Error('comparison observer unexpectedly returned content rows');
    if (result.state === 'ready') {
      const canonical = [...(payload.expectedContent as [string, string][])].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const fingerprint = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
      if (result.fingerprint !== fingerprint) throw new Error(`ready fingerprint mismatch: expected ${fingerprint}, got ${result.fingerprint}`);
    }
  } else {
    if (!Array.isArray(result.content) || result.content.length !== result.paths) throw new Error('baseline observer returned an invalid content map');
    const paths = new Set<string>();
    for (const row of result.content) {
      if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !/^[0-9a-f]{64}$/.test(row[1]) || paths.has(row[0])) throw new Error('baseline observer returned a malformed or duplicate content row');
      paths.add(row[0]);
    }
    const expectedPaths = new Set(payload.manifest.map((entry) => entry.rel));
    for (const path of paths) if (!expectedPaths.has(path)) throw new Error(`baseline observer returned an unexpected content path: ${path}`);
    for (const path of expectedPaths) if (!paths.has(path)) throw new Error(`baseline observer omitted content path: ${path}`);
    if (result.state === 'ready') {
      const canonical = [...result.content].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const fingerprint = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
      if (result.fingerprint !== fingerprint) throw new Error(`baseline fingerprint mismatch: expected ${fingerprint}, got ${result.fingerprint}`);
    }
  }
  return result;
}

// The reason a cancelled attempt rejects with: the caller's own signal.reason, alone when cleanup was
// clean, and alongside the cleanup outcome when it was not; never masked.
function abortRejection(signal: AbortSignal, problems: string[], cleanup: string) {
  const unclean = problems.filter((problem) => !problem.startsWith('aborted'));
  if (unclean.length === 0 && cleanup !== 'unresolved') return signal.reason;
  return new AggregateError([signal.reason, new Error(`native observer cleanup after abort: ${unclean.join('; ') || `cleanup ${cleanup}`}`)], 'native observer was aborted and its cleanup did not complete');
}

// One attempt is an owned job (step-process.ts), so the observer and anything it starts (an npm
// install of a native peer) are released together. No elapsed time ends an attempt; a caller may
// cancel it with an AbortSignal, which fails the job, waits for its cleanup, then rejects.
export async function runNativeObserverAttempt(payload: ObserverInput, { signal }: { signal?: AbortSignal } = {}) {
  if (signal?.aborted) throw signal.reason;
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch (err) {
    throw new Error(`native observer payload is not serializable: ${(err as ErrorDetails | null | undefined)?.message ?? err}`);
  }
  const job = spawnOwned([process.execPath, fileURLToPath(import.meta.url), '--child'], { ipc: true });
  let stdout = '';
  let stderr = '';
  let outputBytes = 0;
  let failure: string | null = null;
  const stop = (reason: string) => {
    failure ??= reason;
    job.fail(reason);
  };
  job.stdout.on('data', (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > MAX_OUTPUT_BYTES) return stop(`exceeded ${MAX_OUTPUT_BYTES} output bytes`);
    stdout += chunk;
  });
  job.stderr.on('data', (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > MAX_OUTPUT_BYTES) return stop(`exceeded ${MAX_OUTPUT_BYTES} output bytes`);
    stderr += chunk;
  });
  job.onMessage((message) => {
    if ((message as { type?: unknown } | null)?.type !== 'supervised') stop(`invalid worker message ${JSON.stringify(message)}`);
  });
  if (!job.send(serialized)) stop('IPC payload could not be queued');
  const onAbort = () => job.fail('aborted by the caller');
  signal?.addEventListener('abort', onAbort, { once: true });
  let result: Awaited<typeof job.result>;
  try {
    result = await job.result;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  if (signal?.aborted) throw abortRejection(signal, jobProblems(result), result.cleanup);
  const outcome = typeof result.command === 'object' ? result.command : null;
  const reaped = outcome ? (outcome.signal ?? outcome.code) : result.command;
  const problems = jobProblems(result, failure);
  if (problems.length > 0) throw new Error(`native observer ${problems.join('; ')}; reaped ${reaped}; cleanup ${result.cleanup}; stderr=${stderr.trim() || 'none'}`);
  if (!outcome || outcome.code !== 0) throw new Error(`native observer failed: exit ${outcome?.code ?? 'unknown'}${outcome?.signal ? ` (${outcome.signal})` : ''}: ${stderr.trim() || 'no stderr'}`);
  try {
    const lines = stdout.trim().split('\n');
    if (lines.length !== 1) throw new Error(`expected one JSON line, got ${lines.length}`);
    return validateResult(JSON.parse(lines[0] as string), payload);
  } catch (err) {
    throw new Error(`native observer returned malformed output: ${(err as ErrorDetails | null | undefined)?.message ?? err}; stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`);
  }
}

// Polls until the index is ready. A locked or stale attempt is retried at POLL_MS; any other
// attempt failure is thrown. Nothing here expires: a cache that never becomes ready waits for the
// run, or the caller's AbortSignal, to cancel it. An abort during the poll wait starts no attempt.
export async function waitForNativeIndex(payload: ObserverInput, { signal }: { signal?: AbortSignal } = {}) {
  const started = process.hrtime.bigint();
  const attempts: Pick<ObserverResult, 'state' | 'mismatch' | 'timings'>[] = [];
  for (;;) {
    const result = await runNativeObserverAttempt(payload, { signal });
    attempts.push({ state: result.state, mismatch: result.mismatch, timings: result.timings });
    if (result.state === 'ready') return { ...result, attempts, total_ms: elapsedMs(started), lock_retries: attempts.filter((item) => item.state === 'locked').length, stale_retries: attempts.filter((item) => item.state === 'stale').length };
    await new Promise<void>((resolvePoll) => {
      const done = () => {
        clearTimeout(poll);
        signal?.removeEventListener('abort', done);
        resolvePoll();
      };
      const poll = setTimeout(done, POLL_MS);
      signal?.addEventListener('abort', done, { once: true });
    });
    if (signal?.aborted) throw signal.reason;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--child') await childMain();
