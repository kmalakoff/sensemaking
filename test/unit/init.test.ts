import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG_FILENAME, initConfig, loadConfig, SenseError, SUPPORTED_CONFIG_VERSION } from 'sensemaking';
import { packageRoot, runCli } from '../lib/cli.ts';

describe('init', () => {
  it('writes the exact v5 starter, model named explicitly, and it round-trips loadConfig cleanly', () => {
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
      assert.deepEqual(cfg.embed, { model: 'minishlab/potion-retrieval-32M', provider: 'static' });
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

// --model / --provider / --url map onto the embed block's own keys one-to-one; no flag
// keeps the built-in default (potion-retrieval-32M, static).
describe('init flags', () => {
  it('--model and --provider and --url override the starter embed block', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sense-init-'));
    try {
      const result = runCli(['init', '--model', 'nomic-ai/nomic-embed-text-v1.5', '--provider', 'openai', '--url', 'http://localhost:11434/v1'], { cwd: dir });
      assert.equal(result.status, 0, result.stderr);

      const cfg = JSON.parse(readFileSync(join(dir, CONFIG_FILENAME), 'utf8'));
      assert.deepEqual(cfg.embed, { model: 'nomic-ai/nomic-embed-text-v1.5', provider: 'openai', url: 'http://localhost:11434/v1' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no flags keeps the default model and provider', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sense-init-'));
    try {
      const result = runCli(['init'], { cwd: dir });
      assert.equal(result.status, 0, result.stderr);
      const cfg = JSON.parse(readFileSync(join(dir, CONFIG_FILENAME), 'utf8'));
      assert.deepEqual(cfg.embed, { model: 'minishlab/potion-retrieval-32M', provider: 'static' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--help documents --model, --provider, and --url', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sense-init-'));
    try {
      const result = runCli(['init', '--help'], { cwd: dir });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /--model/);
      assert.match(result.stdout, /--provider/);
      assert.match(result.stdout, /--url/);
      assert.equal(existsSync(join(dir, CONFIG_FILENAME)), false, 'init --help wrote a config');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an invalid --provider is rejected with validateConfig's own error, and writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), 'sense-init-'));
    try {
      const result = runCli(['init', '--provider', 'bogus'], { cwd: dir });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /embed\.provider must be "static", "openai", or "cohere"/);
      assert.equal(existsSync(join(dir, CONFIG_FILENAME)), false, 'a rejected --provider wrote a config anyway');
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
