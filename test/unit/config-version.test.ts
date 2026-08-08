import assert from 'assert';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const cliPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'cli.js');

function runCli(configPath: string) {
  return spawnSync(process.execPath, [cliPath, '--list', '--config', configPath], {
    encoding: 'utf8',
  });
}

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
    const configPath = writeConfig(2);
    const result = runCli(configPath);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /config version 2 requires a newer sense/);
  });

  it('version 1: works', () => {
    const configPath = writeConfig(1);
    const result = runCli(configPath);
    assert.equal(result.status, 0);
  });

  it('version missing: treated as 1, works', () => {
    const configPath = writeConfig(undefined);
    const result = runCli(configPath);
    assert.equal(result.status, 0);
  });
});
