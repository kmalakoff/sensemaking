import assert from 'assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CONFIG_FILENAME, initConfig, SenseError, SUPPORTED_CONFIG_VERSION } from 'sensemaking';

describe('init', () => {
  it('writes a starter config that is itself valid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sense-init-'));
    try {
      const configPath = initConfig(dir);
      assert.equal(configPath, join(dir, CONFIG_FILENAME));

      const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
      assert.equal(cfg.version, SUPPORTED_CONFIG_VERSION);
      assert.ok(Array.isArray(cfg.scan.include) && cfg.scan.include.length > 0);
      assert.ok(Object.keys(cfg.queries).length > 0);
      for (const sql of Object.values(cfg.queries)) assert.equal(typeof sql, 'string');
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
