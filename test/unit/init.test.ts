import assert from 'assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CONFIG_FILENAME, initConfig, loadConfig, SenseError, SUPPORTED_CONFIG_VERSION } from 'sensemaking';

describe('init', () => {
  it('writes the exact v3 starter from the presets design doc, and it round-trips loadConfig cleanly', () => {
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
      assert.equal(cfg.embed, undefined);
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
