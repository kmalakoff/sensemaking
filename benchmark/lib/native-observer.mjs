import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { platform } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { indexSnapshotMismatch, readIndexSnapshot } from './work-tree.mjs';

const DIALECT_EXPORT = { sqlite: 'sqliteOpenDialect', duckdb: 'duckdbOpenDialect', turso: 'tursoOpenDialect' };
const POLL_MS = 25;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const elapsedMs = (started) => Number(process.hrtime.bigint() - started) / 1e6;

async function observeDuckdbLexical(conn, lexical) {
  await conn.exec('INSTALL fts; LOAD fts;');
  const docsStatement = await conn.prepare('SELECT name FROM fts_main_content.docs ORDER BY name');
  const docsRows = await docsStatement.all();
  const indexedPaths = docsRows.map((row) => row.name);
  const indexedDocs = indexedPaths.length;
  if (indexedPaths.some((path) => typeof path !== 'string') || new Set(indexedPaths).size !== indexedDocs) throw new Error('DuckDB FTS docs returned malformed or duplicate paths');
  const matchStatement = await conn.prepare(`SELECT path FROM (
    SELECT content."path" AS path, fts_main_content.match_bm25(content."path", ?, conjunctive := true) AS score
    FROM content
  ) matches WHERE score IS NOT NULL ORDER BY score DESC, path LIMIT ?`);
  const rows = await matchStatement.all(lexical.terms, lexical.limit);
  const paths = rows.map((row) => row.path);
  return { state: 'ready', indexed_docs: indexedDocs, indexed_paths: indexedPaths, paths };
}

export async function observeNativeIndex({ pkgRoot, store, configPath, manifest, expectedContent = null, authoredContent = null, lexical = null }) {
  const exportName = DIALECT_EXPORT[store];
  if (!exportName) throw new Error(`native observer has no dialect mapping for store ${JSON.stringify(store)}`);
  const moduleUrl = pathToFileURL(resolve(pkgRoot, 'dist', 'esm', 'store', store, 'open.js')).href;
  const publicUrl = pathToFileURL(resolve(pkgRoot, 'dist', 'esm', 'index.js')).href;
  let dialect;
  let loadConfig;
  try {
    dialect = (await import(moduleUrl))[exportName];
    ({ loadConfig } = await import(publicUrl));
  } catch (err) {
    throw new Error(`native observer could not import ${moduleUrl}: ${err?.message ?? err}`);
  }
  if (!dialect?.connect || !dialect?.close || !dialect.filename) throw new Error(`native observer ${moduleUrl} has no ${exportName} connect/close seam`);
  if (typeof loadConfig !== 'function') throw new Error(`native observer ${publicUrl} has no loadConfig export`);
  const cfg = loadConfig(configPath);

  const timings = {};
  let connected;
  let result;
  let operationError;
  try {
    const connectStarted = process.hrtime.bigint();
    try {
      connected = await dialect.connect(resolve(cfg.baseDir, '.sense', dialect.filename), cfg);
    } catch (err) {
      timings.connect_ms = elapsedMs(connectStarted);
      if (dialect.isLocked?.(err)) result = { state: 'locked', timings };
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

  let closeError;
  if (connected) {
    const closeStarted = process.hrtime.bigint();
    try {
      await dialect.close(connected.handle);
      timings.close_ms = elapsedMs(closeStarted);
    } catch (err) {
      closeError = err;
    }
  }
  if (operationError || closeError) {
    const messages = [operationError && `operation: ${operationError?.stack ?? operationError}`, closeError && `close: ${closeError?.stack ?? closeError}`].filter(Boolean);
    throw new Error(`native observer failed (${messages.join('; ')})`);
  }
  return result;
}

export async function nativeObserverDeadlineMs(pkgRoot, baseDir) {
  const moduleUrl = pathToFileURL(resolve(pkgRoot, 'dist', 'esm', 'store', 'lock-wait.js')).href;
  let lockWaitBudgetMs;
  try {
    ({ lockWaitBudgetMs } = await import(moduleUrl));
  } catch (err) {
    throw new Error(`native observer could not import ${moduleUrl}: ${err?.message ?? err}`);
  }
  if (typeof lockWaitBudgetMs !== 'function') throw new Error(`native observer ${moduleUrl} has no lockWaitBudgetMs export`);
  const deadlineMs = lockWaitBudgetMs(baseDir);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw new Error(`native observer returned invalid lock-wait budget ${JSON.stringify(deadlineMs)}`);
  return deadlineMs;
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
    const inputPromise = new Promise((resolveInput, rejectInput) => {
      process.once('message', resolveInput);
      process.once('error', rejectInput);
    });
    await new Promise((resolveReady, rejectReady) => send({ type: 'supervised' }, (err) => (err ? rejectReady(err) : resolveReady())));
    const input = await inputPromise;
    if (typeof input !== 'string') throw new Error('native observer received a non-string payload');
    const result = await observeNativeIndex(JSON.parse(input));
    await new Promise((resolveWrite, rejectWrite) => process.stdout.write(`${JSON.stringify(result)}\n`, (err) => (err ? rejectWrite(err) : resolveWrite())));
  } catch (err) {
    process.stderr.write(`${err?.stack ?? err}\n`);
    process.exitCode = 1;
  } finally {
    completed = true;
    if (process.connected) process.disconnect();
  }
}

// Detached POSIX children own a process group. Windows has no negative-pid group signalling, so
// taskkill /T is the system process-tree operation. Callers still wait for the child's close event.
export function signalProcessTree(child, signal = 'SIGKILL') {
  if (!child?.pid) throw new Error('cannot signal a child process before it has a pid');
  if (platform() === 'win32') {
    const killed = spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { encoding: 'utf8' });
    if (killed.status !== 0 && child.exitCode === null && child.signalCode === null) throw new Error(`taskkill failed: ${killed.stderr || killed.stdout || `exit ${killed.status}`}`);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (err) {
    if (err?.code !== 'ESRCH') throw err;
  }
}

function validTiming(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validateResult(result, payload) {
  const expectsContent = payload.expectedContent != null;
  if (!['ready', 'stale', 'locked'].includes(result?.state)) throw new Error(`invalid state ${JSON.stringify(result?.state)}`);
  if (!result.timings || !validTiming(result.timings.connect_ms)) throw new Error('missing finite connect timing');
  if (result.state === 'locked') return result;
  if (!validTiming(result.timings.snapshot_ms) || !validTiming(result.timings.close_ms)) throw new Error('missing finite snapshot/close timing');
  if (!Number.isInteger(result.paths) || result.paths < 0) throw new Error(`invalid path count ${JSON.stringify(result.paths)}`);
  if (!/^[0-9a-f]{64}$/.test(result.fingerprint)) throw new Error(`invalid fingerprint ${JSON.stringify(result.fingerprint)}`);
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
    if (expectedPaths.some((path) => !observation.paths.includes(path))) throw new Error(`DuckDB lexical result omitted a public result path: expected ${JSON.stringify(expectedPaths)}, got ${JSON.stringify(observation.paths)}`);
  }
  if (expectsContent) {
    if (result.content !== undefined) throw new Error('comparison observer unexpectedly returned content rows');
    if (result.state === 'ready') {
      const canonical = [...payload.expectedContent].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const fingerprint = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
      if (result.fingerprint !== fingerprint) throw new Error(`ready fingerprint mismatch: expected ${fingerprint}, got ${result.fingerprint}`);
    }
  } else {
    if (!Array.isArray(result.content) || result.content.length !== result.paths) throw new Error('baseline observer returned an invalid content map');
    const paths = new Set();
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

export function runNativeObserverAttempt(payload, timeoutMs) {
  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch (err) {
    return Promise.reject(new Error(`native observer payload is not serializable: ${err?.message ?? err}`));
  }
  return new Promise((resolveAttempt, rejectAttempt) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child'], { detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let failure = null;
    let shutdownStarted = false;
    let killTimer = null;
    const requestShutdown = (reason) => {
      failure ??= reason;
      if (shutdownStarted || !child.pid) return;
      shutdownStarted = true;
      try {
        signalProcessTree(child, 'SIGTERM');
      } catch (err) {
        failure = `${failure}; shutdown: ${err?.message ?? err}`;
      }
      killTimer = setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) signalProcessTree(child, 'SIGKILL');
        } catch (err) {
          failure = `${failure}; forced shutdown: ${err?.message ?? err}`;
        }
      }, 1000);
    };
    const timer = setTimeout(() => requestShutdown(`timed out after ${timeoutMs}ms`), timeoutMs);
    const collect = (which) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) return requestShutdown(`exceeded ${MAX_OUTPUT_BYTES} output bytes`);
      if (which === 'stdout') stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.on('error', (err) => requestShutdown(`spawn error: ${err?.message ?? err}`));
    child.on('message', (message) => {
      if (message?.type !== 'supervised') requestShutdown(`invalid worker message ${JSON.stringify(message)}`);
    });
    try {
      child.send(serialized, (err) => {
        if (err) requestShutdown(`IPC payload failed: ${err?.message ?? err}`);
      });
    } catch (err) {
      requestShutdown(`IPC payload failed: ${err?.message ?? err}`);
    }
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (failure) return rejectAttempt(new Error(`native observer ${failure}; reaped ${signal ?? code}; stderr=${stderr.trim() || 'none'}`));
      if (code !== 0) return rejectAttempt(new Error(`native observer failed: exit ${code}${signal ? ` (${signal})` : ''}: ${stderr.trim() || 'no stderr'}`));
      try {
        const lines = stdout.trim().split('\n');
        if (lines.length !== 1) throw new Error(`expected one JSON line, got ${lines.length}`);
        resolveAttempt(validateResult(JSON.parse(lines[0]), payload));
      } catch (err) {
        rejectAttempt(new Error(`native observer returned malformed output: ${err?.message ?? err}; stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`));
      }
    });
  });
}

export function nativeObserverAttemptBudgetMs(deadlineMs, remainingMs) {
  return remainingMs > 0 ? deadlineMs : 0;
}

export async function waitForNativeIndex(payload, deadlineMs) {
  const started = process.hrtime.bigint();
  const deadline = Date.now() + deadlineMs;
  const attempts = [];
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`native observer readiness timed out after ${deadlineMs}ms`);
    // The tree's lock-wait budget decides whether another attempt may begin. A begun native
    // process retains that full bound so the deadline's final fragment cannot become a startup race.
    const result = await runNativeObserverAttempt(payload, nativeObserverAttemptBudgetMs(deadlineMs, remaining));
    attempts.push({ state: result.state, mismatch: result.mismatch, timings: result.timings });
    if (result.state === 'ready') return { ...result, attempts, total_ms: elapsedMs(started), lock_retries: attempts.filter((item) => item.state === 'locked').length, stale_retries: attempts.filter((item) => item.state === 'stale').length };
    await new Promise((resolvePoll) => setTimeout(resolvePoll, Math.min(POLL_MS, Math.max(0, deadline - Date.now()))));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--child') await childMain();
