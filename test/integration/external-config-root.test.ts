import assert from 'node:assert';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig, open, runWatch, search } from 'sensemaking';
import { WATCH_CLAIM_FILENAME, WATCH_HEARTBEAT_INTERVAL_MS } from '../../src/watch-claim.ts';
import { runCli } from '../lib/cli.ts';
import { scratchDir } from '../lib/scratch.ts';
import { forEachStore, type ParityStoreName } from '../lib/stores.ts';
import { writeNote } from '../lib/tree.ts';

function fixture(root = '../tree'): { base: string; configDir: string; treeDir: string; configPath: string } {
  const base = scratchDir('external-config-root');
  const configDir = join(base, 'config');
  const treeDir = join(base, 'tree');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(treeDir, { recursive: true });
  const configPath = join(configDir, 'sense.config.json');
  writeFileSync(configPath, JSON.stringify({ version: 5, root, presets: { default: { include: ['vault/**/*.md'] } }, queries: { vault: { sql: "SELECT path FROM frontmatter WHERE path LIKE 'vault/%' ORDER BY path" } } }));
  return { base, configDir, treeDir, configPath };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for watcher reconciliation');
    await sleep(10);
  }
}

function writeConfig(configPath: string, store: ParityStoreName, include: string[], owner: string): void {
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 5,
      root: '../tree',
      store,
      presets: { default: { include } },
      queries: { owned: { sql: `SELECT '${owner}' AS owner, "path" FROM frontmatter ORDER BY "path"` } },
    })
  );
}

function lockWaitPath(configDir: string): string {
  return join(configDir, '.sense', 'lock-wait.json');
}

function recordedLockWait(path: string): number {
  const value = JSON.parse(readFileSync(path, 'utf8')).reconcile_max_ms;
  assert.equal(typeof value, 'number');
  assert.ok(Number.isFinite(value) && value >= 0);
  return value;
}

async function indexSnapshot(opened: Awaited<ReturnType<typeof open>>): Promise<{ dbPath: string; paths: string[]; memberships: Array<{ path: string; preset: string }> }> {
  const paths = ((await (await opened.store.prepare('SELECT "path" FROM frontmatter ORDER BY "path"')).all()) as Array<{ path: string }>).map((row) => row.path);
  const memberships = (await (await opened.store.prepare('SELECT "path", preset FROM preset_files ORDER BY "path", preset')).all()) as Array<{ path: string; preset: string }>;
  return { dbPath: opened.dbPath, paths, memberships };
}

async function readIndex(configPath: string): Promise<Awaited<ReturnType<typeof indexSnapshot>>> {
  const opened = await open(loadConfig(configPath));
  try {
    return await indexSnapshot(opened);
  } finally {
    await opened.store.close();
  }
}

describe('external configuration root', () => {
  it('resolves a relative root from the config, stores root-relative paths, and keeps state beside the config', async () => {
    const { configDir, treeDir, configPath } = fixture();
    writeNote(treeDir, 'vault/Note.md', { frontmatter: { title: 'External note' }, body: 'needle' });
    const configLockWait = lockWaitPath(configDir);
    const treeStateDir = join(treeDir, '.sense');
    mkdirSync(treeStateDir);
    const treeSentinel = join(treeStateDir, 'lock-wait.json');
    const sentinelContents = JSON.stringify({ owner: 'tree' });
    writeFileSync(treeSentinel, sentinelContents);

    const cfg = loadConfig(configPath);
    assert.equal(cfg.configDir, configDir);
    assert.equal(cfg.rootDir, treeDir, 'root is relative to the config file, never cwd');
    const opened = await open(cfg);
    try {
      assert.deepEqual(
        (await search(opened.store, opened.cfg, 'needle')).map((row) => row.path),
        ['vault/Note.md']
      );
      const rows = (await (await opened.store.prepare("SELECT path FROM frontmatter WHERE path LIKE 'vault/%'")).all()) as Array<{ path: string }>;
      assert.deepEqual(rows, [{ path: 'vault/Note.md' }]);
    } finally {
      await opened.store.close();
    }
    assert.ok(existsSync(join(configDir, '.sense', 'cache.db')));
    assert.ok(recordedLockWait(configLockWait) >= 0, 'the config-owned lock-wait record was not updated');
    assert.equal(readFileSync(treeSentinel, 'utf8'), sentinelContents, "the indexed tree's existing state must remain untouched");
    assert.ok(!existsSync(join(treeStateDir, 'cache.db')), "the indexed tree does not own this config's cache");

    // Saved SQL remains useful because it sees root-relative paths, even though the config lives elsewhere.
    const saved = runCli(['vault', '--format', 'json', '--config', configPath]);
    assert.equal(saved.status, 0, saved.stderr);
    assert.deepEqual(JSON.parse(saved.stdout), [{ path: 'vault/Note.md' }]);

    const status = runCli(['status', '--format', 'json', '--config', configPath]);
    assert.equal(status.status, 0, status.stderr);
    assert.deepEqual(JSON.parse(status.stdout).configDir, configDir);
    assert.deepEqual(JSON.parse(status.stdout).treeRoot, treeDir);
  });

  // This proves eventual convergence through notification or the shipped periodic pass; it does not
  // claim which path triggered reconciliation because native watcher delivery is not guaranteed.
  it('eventually reconciles a synchronous post-start edit from the configured root', async () => {
    const { configPath, treeDir } = fixture();
    writeNote(treeDir, 'vault/Before.md', { body: 'before' });
    const cfg = loadConfig(configPath);
    const controller = new AbortController();
    const events: Array<{ type: string; rootDir?: string; parsed?: number; total?: number; message?: string }> = [];
    const done = runWatch(cfg, {
      signal: controller.signal,
      debounceMs: 10,
      onEvent: (event) => {
        events.push(event);
        if (event.type === 'started') writeNote(treeDir, 'vault/After.md', { body: 'after' });
      },
    });
    const outcome = Promise.allSettled([done]).then(([result]) => result);
    let bodyFailed = false;
    let bodyFailure: unknown;
    let finalOutcome: PromiseSettledResult<void> | null = null;
    try {
      const early = await Promise.race([
        waitFor(() => {
          const reconcileError = events.find((event) => event.type === 'reconcile-error');
          if (reconcileError) throw new Error(`watcher reported reconcile-error: ${reconcileError.message}`);
          return events.some((event) => event.type === 'reconciled' && (event.parsed ?? 0) > 0 && event.total === 2);
        }, WATCH_HEARTBEAT_INTERVAL_MS + 5_000).catch((err) => {
          throw new Error(`watcher reconciliation observation failed; events=${JSON.stringify(events)}`, { cause: err });
        }),
        outcome.then((result) => ({ result })),
      ]);
      if (early) {
        if (early.result.status === 'rejected') throw new Error(`runWatch rejected before reconciliation; events=${JSON.stringify(events)}`, { cause: early.result.reason });
        throw new Error(`runWatch resolved before reconciliation; events=${JSON.stringify(events)}`);
      }
      assert.equal(events.find((event) => event.type === 'started')?.rootDir, treeDir);
    } catch (err) {
      bodyFailed = true;
      bodyFailure = err;
    } finally {
      controller.abort();
      finalOutcome = await outcome;
    }
    if (bodyFailed) throw bodyFailure;
    if (!finalOutcome) throw new Error(`runWatch cleanup outcome was not recorded; events=${JSON.stringify(events)}`);
    if (finalOutcome.status === 'rejected') throw new Error(`runWatch rejected during cleanup; events=${JSON.stringify(events)}`, { cause: finalOutcome.reason });

    const reopened = await open(loadConfig(configPath));
    try {
      const rows = (await (await reopened.store.prepare('SELECT path FROM frontmatter ORDER BY path')).all()) as Array<{ path: string }>;
      assert.deepEqual(rows, [{ path: 'vault/After.md' }, { path: 'vault/Before.md' }]);
    } finally {
      await reopened.store.close();
    }
  });

  it('rebuilds when root changes', async () => {
    const { base, treeDir, configPath } = fixture();
    const otherTree = join(base, 'other-tree');
    mkdirSync(otherTree);
    writeNote(treeDir, 'vault/One.md', { body: 'one' });
    writeNote(otherTree, 'vault/Two.md', { body: 'two' });

    let opened = await open(loadConfig(configPath));
    await opened.store.close();
    writeFileSync(configPath, JSON.stringify({ version: 5, root: '../other-tree', presets: { default: { include: ['vault/**/*.md'] } }, queries: {} }));
    opened = await open(loadConfig(configPath));
    try {
      const rows = (await (await opened.store.prepare('SELECT path FROM frontmatter')).all()) as Array<{ path: string }>;
      assert.deepEqual(rows, [{ path: 'vault/Two.md' }], 'a different root cannot retain rows from the old tree');
    } finally {
      await opened.store.close();
    }
  });

  it('keeps same-root configurations independent across every store', async () => {
    await forEachStore(async (store) => {
      const base = scratchDir(`same-root-configs-${store}`);
      const treeDir = join(base, 'tree');
      const firstConfigDir = join(base, 'config-a');
      const secondConfigDir = join(base, 'config-b');
      mkdirSync(treeDir);
      mkdirSync(firstConfigDir);
      mkdirSync(secondConfigDir);
      writeNote(treeDir, 'alpha/One.md', { body: 'alpha' });
      writeNote(treeDir, 'beta/Two.md', { body: 'beta' });
      writeNote(treeDir, 'shared/Three.md', { body: 'shared' });

      const firstConfigPath = join(firstConfigDir, 'sense.config.json');
      const secondConfigPath = join(secondConfigDir, 'sense.config.json');
      writeConfig(firstConfigPath, store, ['alpha/**/*.md'], 'config-a');
      writeConfig(secondConfigPath, store, ['beta/**/*.md'], 'config-b');
      const firstLockWait = lockWaitPath(firstConfigDir);
      const secondLockWait = lockWaitPath(secondConfigDir);

      const firstOpened = await open(loadConfig(firstConfigPath));
      try {
        const secondOpened = await open(loadConfig(secondConfigPath));
        try {
          const first = await indexSnapshot(firstOpened);
          const second = await indexSnapshot(secondOpened);
          assert.deepEqual(first.paths, ['alpha/One.md']);
          assert.deepEqual(first.memberships, [{ path: 'alpha/One.md', preset: 'default' }]);
          assert.deepEqual(second.paths, ['beta/Two.md']);
          assert.deepEqual(second.memberships, [{ path: 'beta/Two.md', preset: 'default' }]);
          assert.equal(dirname(first.dbPath), join(firstConfigDir, '.sense'));
          assert.equal(dirname(second.dbPath), join(secondConfigDir, '.sense'));
          assert.notEqual(first.dbPath, second.dbPath);
          assert.ok(recordedLockWait(firstLockWait) >= 0);
          assert.ok(recordedLockWait(secondLockWait) >= 0);
          assert.ok(!existsSync(join(treeDir, '.sense')), 'the shared tree must not acquire config-owned state');
        } finally {
          await secondOpened.store.close();
        }
      } finally {
        await firstOpened.store.close();
      }

      const firstSaved = runCli(['owned', '--format', 'json', '--config', firstConfigPath]);
      const secondSaved = runCli(['owned', '--format', 'json', '--config', secondConfigPath]);
      assert.equal(firstSaved.status, 0, firstSaved.stderr);
      assert.equal(secondSaved.status, 0, secondSaved.stderr);
      assert.deepEqual(JSON.parse(firstSaved.stdout), [{ owner: 'config-a', path: 'alpha/One.md' }]);
      assert.deepEqual(JSON.parse(secondSaved.stdout), [{ owner: 'config-b', path: 'beta/Two.md' }]);

      const secondLockWaitBytes = readFileSync(secondLockWait);
      writeConfig(firstConfigPath, store, ['alpha/**/*.md', 'shared/**/*.md'], 'config-a');
      const changedFirst = await readIndex(firstConfigPath);
      const unchangedSecond = await readIndex(secondConfigPath);
      assert.deepEqual(changedFirst.paths, ['alpha/One.md', 'shared/Three.md']);
      assert.deepEqual(changedFirst.memberships, [
        { path: 'alpha/One.md', preset: 'default' },
        { path: 'shared/Three.md', preset: 'default' },
      ]);
      assert.deepEqual(unchangedSecond.paths, ['beta/Two.md']);
      assert.deepEqual(unchangedSecond.memberships, [{ path: 'beta/Two.md', preset: 'default' }]);
      assert.deepEqual(readFileSync(secondLockWait), secondLockWaitBytes, 'config A invalidation must not rewrite config B lock metadata');
    });
  });

  it('runs independent config-owned watchers against the same root', async () => {
    const base = scratchDir('same-root-watchers');
    const treeDir = join(base, 'tree');
    const firstConfigDir = join(base, 'config-a');
    const secondConfigDir = join(base, 'config-b');
    mkdirSync(treeDir);
    mkdirSync(firstConfigDir);
    mkdirSync(secondConfigDir);
    const firstConfigPath = join(firstConfigDir, 'sense.config.json');
    const secondConfigPath = join(secondConfigDir, 'sense.config.json');
    writeConfig(firstConfigPath, 'sqlite', ['alpha/**/*.md'], 'config-a');
    writeConfig(secondConfigPath, 'sqlite', ['beta/**/*.md'], 'config-b');
    writeNote(treeDir, 'alpha/One.md', { body: 'alpha one' });
    writeNote(treeDir, 'beta/One.md', { body: 'beta one' });

    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstEvents: Array<{ type: string; parsed?: number }> = [];
    const secondEvents: Array<{ type: string; parsed?: number }> = [];
    const firstDone = runWatch(loadConfig(firstConfigPath), { signal: firstController.signal, debounceMs: 10, heartbeatIntervalMs: 60_000, onEvent: (event) => firstEvents.push(event) });
    const secondDone = runWatch(loadConfig(secondConfigPath), { signal: secondController.signal, debounceMs: 10, heartbeatIntervalMs: 60_000, onEvent: (event) => secondEvents.push(event) });
    const outcomes = Promise.allSettled([firstDone, secondDone]);
    const firstEarlyExit = firstDone.then(
      () => {
        throw new Error('first watcher stopped before the independent-config check completed');
      },
      (err) => {
        throw err;
      }
    );
    const secondEarlyExit = secondDone.then(
      () => {
        throw new Error('second watcher stopped before the independent-config check completed');
      },
      (err) => {
        throw err;
      }
    );
    let bodyFailed = false;
    let bodyFailure: unknown;
    let cleanupResults: Awaited<typeof outcomes> | null = null;
    try {
      await Promise.race([waitFor(() => firstEvents.some((event) => event.type === 'started') && secondEvents.some((event) => event.type === 'started')), firstEarlyExit, secondEarlyExit]);
      assert.ok(existsSync(join(firstConfigDir, WATCH_CLAIM_FILENAME)));
      assert.ok(existsSync(join(secondConfigDir, WATCH_CLAIM_FILENAME)));
      assert.equal(existsSync(join(treeDir, WATCH_CLAIM_FILENAME)), false, 'the shared root must not own either watcher claim');

      const firstBefore = firstEvents.length;
      const secondBefore = secondEvents.length;
      writeNote(treeDir, 'alpha/Two.md', { body: 'alpha two' });
      writeNote(treeDir, 'beta/Two.md', { body: 'beta two' });
      await Promise.race([waitFor(() => firstEvents.slice(firstBefore).some((event) => event.type === 'reconciled' && event.parsed === 1) && secondEvents.slice(secondBefore).some((event) => event.type === 'reconciled' && event.parsed === 1)), firstEarlyExit, secondEarlyExit]);
    } catch (err) {
      bodyFailed = true;
      bodyFailure = err;
    } finally {
      firstController.abort();
      secondController.abort();
      cleanupResults = await outcomes;
    }

    if (!cleanupResults) throw new Error('watcher cleanup outcomes were not recorded');
    const cleanupFailures = cleanupResults.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (bodyFailed) {
      if (cleanupFailures.length > 0) throw new AggregateError([bodyFailure, ...cleanupFailures], 'independent-config watcher check and cleanup failed');
      throw bodyFailure;
    }
    if (cleanupFailures.length === 1) throw cleanupFailures[0];
    if (cleanupFailures.length > 1) throw new AggregateError(cleanupFailures, 'independent-config watcher cleanup failed');

    assert.deepEqual((await readIndex(firstConfigPath)).paths, ['alpha/One.md', 'alpha/Two.md']);
    assert.deepEqual((await readIndex(secondConfigPath)).paths, ['beta/One.md', 'beta/Two.md']);
  });

  it('keeps the colocated configuration behavior when root is omitted', async () => {
    const dir = scratchDir('colocated-config-root');
    writeNote(dir, 'Note.md', { body: 'same behavior' });
    const configPath = join(dir, 'sense.config.json');
    writeFileSync(configPath, JSON.stringify({ version: 5, presets: { default: { include: ['*.md'] } }, queries: {} }));
    const cfg = loadConfig(configPath);
    assert.equal(cfg.configDir, dir);
    assert.equal(cfg.rootDir, dir);
    const opened = await open(cfg);
    await opened.store.close();
    assert.ok(existsSync(join(dir, '.sense', 'cache.db')));
  });
});
