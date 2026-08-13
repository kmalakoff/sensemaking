import assert from 'assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SUPPORTED_CONFIG_VERSION } from 'sensemaking';
import { runCli as spawnCli } from '../lib/cli.ts';

const runCli = (configPath: string) => spawnCli(['--list', '--config', configPath]);

function writeConfig(version: number | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), 'sense-version-'));
  const configPath = join(dir, 'sense.config.json');
  const cfg: Record<string, unknown> = { scan: { include: ['*.md'] }, queries: {} };
  if (version !== undefined) cfg.version = version;
  writeFileSync(configPath, JSON.stringify(cfg));
  return configPath;
}

describe('config version', () => {
  it('newer than supported: exit 1 with the version message', () => {
    const configPath = writeConfig(SUPPORTED_CONFIG_VERSION + 1);
    const result = runCli(configPath);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`config version ${SUPPORTED_CONFIG_VERSION + 1} requires a newer sense`));
  });

  it('current version: works, file untouched', () => {
    const configPath = writeConfig(SUPPORTED_CONFIG_VERSION);
    const before = readFileSync(configPath, 'utf8');
    const result = runCli(configPath);
    assert.equal(result.status, 0);
    assert.equal(readFileSync(configPath, 'utf8'), before);
  });

  it('v1 auto-migrates: file rewritten to current version with all features enabled', () => {
    const configPath = writeConfig(1);
    const result = runCli(configPath);
    assert.equal(result.status, 0);
    assert.match(result.stderr, /migrated .* from config version 1 to 2/);

    const migrated = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(migrated.version, SUPPORTED_CONFIG_VERSION);
    assert.deepEqual(migrated.features, { links: true, sections: true, rank: true });
    // original keys survive
    assert.deepEqual(migrated.scan, { include: ['*.md'] });
  });

  it('version missing: treated as v1 and auto-migrated', () => {
    const configPath = writeConfig(undefined);
    const result = runCli(configPath);
    assert.equal(result.status, 0);
    const migrated = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(migrated.version, SUPPORTED_CONFIG_VERSION);
  });

  it('migration happens once: a second run leaves the file untouched', () => {
    const configPath = writeConfig(1);
    runCli(configPath);
    const afterFirst = readFileSync(configPath, 'utf8');
    const second = runCli(configPath);
    assert.equal(second.status, 0);
    assert.ok(!second.stderr.includes('migrated'), `unexpected migration notice: ${second.stderr}`);
    assert.equal(readFileSync(configPath, 'utf8'), afterFirst);
  });
});
