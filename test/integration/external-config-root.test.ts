import assert from 'node:assert';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, open, runWatch, search } from 'sensemaking';
import { runCli } from '../lib/cli.ts';
import { scratchDir } from '../lib/scratch.ts';
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

describe('external configuration root', () => {
  it('resolves a relative root from the config, stores root-relative paths, and keeps state beside the config', async () => {
    const { configDir, treeDir, configPath } = fixture();
    writeNote(treeDir, 'vault/Note.md', { frontmatter: { title: 'External note' }, body: 'needle' });

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
    assert.ok(!existsSync(join(treeDir, '.sense')), "the indexed tree does not own this config's cache");

    // Saved SQL remains useful because it sees root-relative paths, even though the config lives elsewhere.
    const saved = runCli(['vault', '--format', 'json', '--config', configPath]);
    assert.equal(saved.status, 0, saved.stderr);
    assert.deepEqual(JSON.parse(saved.stdout), [{ path: 'vault/Note.md' }]);

    const status = runCli(['status', '--format', 'json', '--config', configPath]);
    assert.equal(status.status, 0, status.stderr);
    assert.deepEqual(JSON.parse(status.stdout).configDir, configDir);
    assert.deepEqual(JSON.parse(status.stdout).treeRoot, treeDir);
  });

  it('watches and reconciles the configured root rather than the config directory', async () => {
    const { configPath, treeDir } = fixture();
    writeNote(treeDir, 'vault/Before.md', { body: 'before' });
    const cfg = loadConfig(configPath);
    const controller = new AbortController();
    const events: Array<{ type: string; rootDir?: string; parsed?: number }> = [];
    const done = runWatch(cfg, { signal: controller.signal, debounceMs: 10, heartbeatIntervalMs: 60_000, onEvent: (event) => events.push(event) });
    await waitFor(() => events.some((event) => event.type === 'started'));
    assert.equal(events.find((event) => event.type === 'started')?.rootDir, treeDir);
    const beforeEdit = events.length;
    writeNote(treeDir, 'vault/After.md', { body: 'after' });
    await waitFor(() => events.slice(beforeEdit).some((event) => event.type === 'reconciled' && (event.parsed ?? 0) > 0));
    controller.abort();
    await done;

    const reopened = await open(loadConfig(configPath));
    try {
      const rows = (await (await reopened.store.prepare('SELECT path FROM frontmatter ORDER BY path')).all()) as Array<{ path: string }>;
      assert.deepEqual(rows, [{ path: 'vault/After.md' }, { path: 'vault/Before.md' }]);
    } finally {
      await reopened.store.close();
    }
  });

  it('rebuilds when root changes and permits independent caches for the same root', async () => {
    const { base, configDir, treeDir, configPath } = fixture();
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

    const secondConfigDir = join(base, 'second-config');
    mkdirSync(secondConfigDir);
    const secondConfigPath = join(secondConfigDir, 'sense.config.json');
    writeFileSync(secondConfigPath, JSON.stringify({ version: 5, root: '../tree', presets: { default: { include: ['vault/**/*.md'] } }, queries: {} }));
    const second = await open(loadConfig(secondConfigPath));
    await second.store.close();
    assert.ok(existsSync(join(configDir, '.sense', 'cache.db')));
    assert.ok(existsSync(join(secondConfigDir, '.sense', 'cache.db')));
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
