import assert from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, SUPPORTED_CONFIG_VERSION } from 'sensemaking';
import { DEFAULT_EMBED_MODEL } from '../../src/config.ts';
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

function writeRaw(cfg: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'sense-version-'));
  const configPath = join(dir, 'sense.config.json');
  writeFileSync(configPath, JSON.stringify(cfg));
  return configPath;
}

describe('config version', () => {
  it('v2 embed object form (api provider settings) survives migration as the v3 embed block', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sense-vv-'));
    const provider = { model: 'custom/m', type: 'api', url: 'http://localhost:11434/v1', key: 'MY_KEY' };
    writeFileSync(join(dir, 'sense.config.json'), JSON.stringify({ version: 2, scan: { include: ['**/*.md'] }, queries: {}, features: { links: true, embed: provider } }));
    const cfg = loadConfig(join(dir, 'sense.config.json'));
    assert.equal(cfg.migratedFrom, 2);
    // Dropping these silently switched an api tree back to the built-in static model.
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'sense.config.json'), 'utf8')).embed, provider);
  });

  it('newer than supported: exit 1 with the version message', () => {
    const configPath = writeConfig(SUPPORTED_CONFIG_VERSION + 1);
    const result = runCli(configPath);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`config version ${SUPPORTED_CONFIG_VERSION + 1} requires a newer sense`));
  });

  it('current version: works, file untouched', () => {
    const configPath = writeRaw({ version: SUPPORTED_CONFIG_VERSION, presets: { default: { include: ['*.md'] } }, queries: {} });
    const before = readFileSync(configPath, 'utf8');
    const result = runCli(configPath);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(configPath, 'utf8'), before);
  });

  it('v1 chains to v3: file rewritten with all opt-out features enabled, embed absent (defaults on)', () => {
    const configPath = writeConfig(1);
    const result = runCli(configPath);
    assert.equal(result.status, 0);
    assert.match(result.stderr, new RegExp(`migrated .* from config version 1 to ${SUPPORTED_CONFIG_VERSION}`));

    const migrated = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(migrated.version, SUPPORTED_CONFIG_VERSION);
    assert.deepEqual(migrated.presets, { default: { include: ['*.md'] } });
    // v1 -> v2 writes the three opt-out features explicitly; embed was never touched, so it
    // stays absent -- which is ON under v3 semantics (no preset gets semantic: false).
    assert.deepEqual(migrated.features, { links: true, sections: true, rank: true });
    assert.equal(migrated.scan, undefined);
    assert.equal(migrated.layers, undefined);
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

  it('regression: a bare v2 config on disk migrates through the CLI entry point, not just loadConfig direct calls', () => {
    // loadConfig must migrate before validating: a pre-preset file checked against the current
    // shape errors on `presets` and the migration never runs.
    const configPath = writeRaw({ version: 2, scan: { include: ['*.md'] }, queries: {} });
    const result = runCli(configPath);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, new RegExp(`migrated .* from config version 2 to ${SUPPORTED_CONFIG_VERSION}`));
    const migrated = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(migrated.version, SUPPORTED_CONFIG_VERSION);
    assert.deepEqual(migrated.presets, { default: { include: ['*.md'] } });
    assert.equal(migrated.scan, undefined);
  });

  it('v2 -> v4 chains: scan->presets.default.include, find->search, defaults.find.where->presets.default.where, semantic drops entirely', () => {
    const configPath = writeRaw({
      version: 2,
      scan: { include: ['*.md'] },
      features: { links: true },
      defaults: { find: { where: "type != 'raw'" } },
      queries: {
        raw: 'SELECT 1',
        saved: { find: 'pricing', k: 5, where: "status='active'", semantic: true },
        savedLex: { find: 'billing', semantic: false },
      },
    });

    const resolved = loadConfig(configPath);
    assert.equal(resolved.migratedFrom, 2);
    assert.deepEqual(resolved.presets, { default: { include: ['*.md'], where: "type != 'raw'" } });
    // embed was absent in the v2 source and no migration step writes it -- it stays absent.
    assert.deepEqual(resolved.features, { links: true });
    // v3's bare string meant SQL by inference; v4 wraps it so the entry names its verb.
    assert.deepEqual(resolved.queries.raw, { sql: 'SELECT 1' });
    assert.deepEqual(resolved.queries.saved, { search: 'pricing', k: 5, where: "status='active'" });
    // v3 kept `semantic: false` on a saved search; v4 has no such key, so it drops.
    assert.deepEqual(resolved.queries.savedLex, { search: 'billing' });

    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(onDisk.scan, undefined);
    assert.equal(onDisk.defaults, undefined);
    assert.equal(onDisk.version, SUPPORTED_CONFIG_VERSION);
    assert.deepEqual(onDisk.presets, { default: { include: ['*.md'], where: "type != 'raw'" } });
    assert.deepEqual(onDisk.features, { links: true });
  });

  it('v2 -> v4: features.embed:false becomes presets.default.semantic:false and no embed block', () => {
    const configPath = writeRaw({ version: 2, scan: { include: ['*.md'] }, features: { embed: false }, queries: {} });
    const resolved = loadConfig(configPath);
    assert.deepEqual(resolved.presets, { default: { include: ['*.md'], semantic: false } });
    assert.equal(resolved.embed, undefined);
    assert.equal(resolved.features, undefined);
  });

  it('v3 -> v4: a tree that embedded gets the model written into the file, and its signature does not move', () => {
    const configPath = writeRaw({ version: 3, presets: { default: { include: ['*.md'] } }, queries: {} });
    const resolved = loadConfig(configPath);
    assert.equal(resolved.migratedFrom, 3);
    assert.deepEqual(resolved.embed, { model: DEFAULT_EMBED_MODEL, type: 'static' });
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(onDisk.version, SUPPORTED_CONFIG_VERSION);
    assert.deepEqual(onDisk.embed, { model: DEFAULT_EMBED_MODEL, type: 'static' });
  });

  it('v3 -> v4: presets keep semantic; all-false means no embed block, so vectors stay off', () => {
    const configPath = writeRaw({ version: 3, presets: { default: { include: ['*.md'], semantic: false }, raw: { include: ['raw/*.md'], semantic: false } }, queries: {} });
    const resolved = loadConfig(configPath);
    assert.equal(resolved.embed, undefined);
    assert.deepEqual(resolved.presets, { default: { include: ['*.md'], semantic: false }, raw: { include: ['raw/*.md'], semantic: false } });
  });

  it('v3 -> v4: a mixed tree keeps its lexical preset and gains the model for the rest', () => {
    const configPath = writeRaw({ version: 3, presets: { default: { include: ['wiki/*.md'] }, raw: { include: ['raw/*.md'], semantic: false } }, queries: {} });
    const resolved = loadConfig(configPath);
    assert.deepEqual(resolved.embed, { model: DEFAULT_EMBED_MODEL, type: 'static' });
    assert.equal(resolved.presets.raw.semantic, false, 'the lexical layer stays lexical');
    assert.equal(resolved.presets.default.semantic, undefined, 'the meaning layer keeps the default');
  });

  it('v3 -> v4: an api embed block keeps model, type, url and key verbatim', () => {
    const provider = { model: 'custom/m', type: 'api', url: 'http://localhost:11434/v1', key: 'MY_KEY' };
    const configPath = writeRaw({ version: 3, presets: { default: { include: ['*.md'] } }, embed: provider, queries: {} });
    const resolved = loadConfig(configPath);
    assert.deepEqual(resolved.embed, provider);
  });

  it('v2 -> v3: checks is dropped with a stderr note, and its queries are carried over as ordinary saved queries', () => {
    const configPath = writeRaw({
      version: 2,
      scan: { include: ['*.md'] },
      queries: { 'dead-links': 'SELECT src FROM links WHERE dst IS NULL' },
      checks: { 'dead-links': 'empty' },
    });
    let stderr = '';
    const originalError = console.error;
    console.error = (msg: string) => {
      stderr += `${msg}\n`;
    };
    let resolved: ReturnType<typeof loadConfig>;
    try {
      resolved = loadConfig(configPath);
    } finally {
      console.error = originalError;
    }
    assert.match(stderr, /checks.*removed in v3/);
    assert.deepEqual(resolved.queries['dead-links'], { sql: 'SELECT src FROM links WHERE dst IS NULL' });
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(onDisk.checks, undefined);
  });
});
