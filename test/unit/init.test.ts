import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG_FILENAME, initConfig, loadConfig, SenseError, SUPPORTED_CONFIG_VERSION } from 'sensemaking';
import { packageRoot, runCli } from '../lib/cli.ts';

describe('init', () => {
  it('writes the exact v4 starter, model named explicitly, and it round-trips loadConfig cleanly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sense-init-'));
    try {
      const configPath = initConfig(dir);
      assert.equal(configPath, join(dir, CONFIG_FILENAME));

      const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
      assert.equal(cfg.version, SUPPORTED_CONFIG_VERSION);
      assert.deepEqual(cfg.presets, {
        default: { include: ['**/*.md'], k: 10 },
        large: { include: ['**/*.md'], k: 20 },
      });
      assert.equal(cfg.features, undefined);
      // Written out, not defaulted in code: this line is what a `sense download` fetches.
      assert.deepEqual(cfg.embed, { model: 'minishlab/potion-retrieval-32M', type: 'static' });
      assert.deepEqual(cfg.queries, {});

      const before = readFileSync(configPath, 'utf8');
      const resolved = loadConfig(configPath);
      assert.equal(resolved.migratedFrom, undefined);
      assert.equal(resolved.unknownKeys, undefined);
      assert.equal(readFileSync(configPath, 'utf8'), before, 'a current-version config is not rewritten on load');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite an existing config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sense-init-'));
    try {
      writeFileSync(join(dir, CONFIG_FILENAME), '{}');
      assert.throws(
        () => initConfig(dir),
        (err: unknown) => err instanceof SenseError && err.code === 'CONFIG_EXISTS'
      );
      assert.equal(readFileSync(join(dir, CONFIG_FILENAME), 'utf8'), '{}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// init's output is the first thing a new tree sees, so a command it names has to exist. It
// pointed at `sense query` for a release after that became `sense sql`.
describe('init next steps name real commands', () => {
  it('every command init suggests is in the registry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sense-init-'));
    const result = runCli(['init'], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    const { COMMANDS } = (await import(pathToFileURL(join(packageRoot, 'dist', 'esm', 'cli', 'index.js')).href)) as { COMMANDS: Record<string, unknown> };
    const suggested = [...result.stdout.matchAll(/\bsense ([a-z]+)/g)].map((m) => m[1]);
    assert.ok(suggested.length > 0, result.stdout);
    for (const name of suggested) {
      assert.ok(name in COMMANDS, `init suggests "sense ${name}", which is not a command`);
    }
  });
});
