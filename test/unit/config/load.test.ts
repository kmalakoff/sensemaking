import assert from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, SUPPORTED_CONFIG_VERSION } from 'sensemaking';
import { DEFAULT_EMBED_MODEL } from '../../../src/config/index.ts';
import { runCli as spawnCli } from '../../lib/cli.ts';
import { scratchDir } from '../../lib/scratch.ts';

const runCli = (configPath: string) => spawnCli(['--list', '--config', configPath]);

function writeConfig(version: number | undefined): string {
  const dir = scratchDir('version');
  const configPath = join(dir, 'sense.config.json');
  const cfg: Record<string, unknown> = { scan: { include: ['*.md'] }, queries: {} };
  if (version !== undefined) cfg.version = version;
  writeFileSync(configPath, JSON.stringify(cfg));
  return configPath;
}

function writeRaw(cfg: Record<string, unknown>): string {
  const dir = scratchDir('version');
  const configPath = join(dir, 'sense.config.json');
  writeFileSync(configPath, JSON.stringify(cfg));
  return configPath;
}

describe('config version', () => {
  it('v2 embed object form (api provider settings) survives migration into the v5 embed block', () => {
    const dir = scratchDir('vv');
    const v2Embed = { model: 'custom/m', type: 'api', url: 'http://localhost:11434/v1', key: 'MY_KEY' };
    writeFileSync(join(dir, 'sense.config.json'), JSON.stringify({ version: 2, scan: { include: ['**/*.md'] }, queries: {}, features: { links: true, embed: v2Embed } }));
    const cfg = loadConfig(join(dir, 'sense.config.json'));
    assert.equal(cfg.migratedFrom, 2);
    // Dropping these silently switched an api tree back to the built-in static model; the v4 ->
    // v5 step along the way renames type to provider ("api" -> "openai").
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'sense.config.json'), 'utf8')).embed, { model: 'custom/m', url: 'http://localhost:11434/v1', key: 'MY_KEY', provider: 'openai' });
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

  it('v2 -> v5: features.embed:false becomes presets.default.signals:{"words":1,"links":1} and no embed block', () => {
    const configPath = writeRaw({ version: 2, scan: { include: ['*.md'] }, features: { embed: false }, queries: {} });
    const resolved = loadConfig(configPath);
    // v2 -> v3 turns this into presets.default.semantic:false; v4 -> v5 migrates that to
    // signals: words plus links, since the links feature defaults on.
    assert.deepEqual(resolved.presets, { default: { include: ['*.md'], signals: { words: 1, links: 1 } } });
    assert.equal(resolved.embed, undefined);
    assert.equal(resolved.features, undefined);
  });

  it('v3 -> v5: a tree that embedded gets the model written into the file, and its signature does not move', () => {
    const configPath = writeRaw({ version: 3, presets: { default: { include: ['*.md'] } }, queries: {} });
    const resolved = loadConfig(configPath);
    assert.equal(resolved.migratedFrom, 3);
    assert.deepEqual(resolved.embed, { model: DEFAULT_EMBED_MODEL, provider: 'static' });
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(onDisk.version, SUPPORTED_CONFIG_VERSION);
    assert.deepEqual(onDisk.embed, { model: DEFAULT_EMBED_MODEL, provider: 'static' });
  });

  it('v3 -> v5: presets keep signals; all-false means no embed block, so vectors stay off', () => {
    const configPath = writeRaw({ version: 3, presets: { default: { include: ['*.md'], semantic: false }, raw: { include: ['raw/*.md'], semantic: false } }, queries: {} });
    const resolved = loadConfig(configPath);
    assert.equal(resolved.embed, undefined);
    assert.deepEqual(resolved.presets, { default: { include: ['*.md'], signals: { words: 1, links: 1 } }, raw: { include: ['raw/*.md'], signals: { words: 1, links: 1 } } });
  });

  it('v3 -> v5: a mixed tree keeps its lexical preset and gains the model for the rest', () => {
    const configPath = writeRaw({ version: 3, presets: { default: { include: ['wiki/*.md'] }, raw: { include: ['raw/*.md'], semantic: false } }, queries: {} });
    const resolved = loadConfig(configPath);
    assert.deepEqual(resolved.embed, { model: DEFAULT_EMBED_MODEL, provider: 'static' });
    assert.deepEqual(resolved.presets.raw.signals, { words: 1, links: 1 }, 'the lexical layer stays lexical, now spelled as signals');
    assert.equal(resolved.presets.default.signals, undefined, 'the meaning layer keeps every signal whose prerequisites hold, so it needs no explicit key');
  });

  it('v4 -> v5: semantic:false migrates to signals, dropping "links" from the exhaustive map when the links feature is off', () => {
    const configPath = writeRaw({ version: 4, presets: { default: { include: ['*.md'], semantic: false } }, features: { links: false }, queries: {} });
    const resolved = loadConfig(configPath);
    assert.deepEqual(resolved.presets.default.signals, { words: 1 }, 'links is off tree-wide, so the migrated preset does not name it');
    assert.equal((resolved.presets.default as { semantic?: boolean }).semantic, undefined, '"semantic" leaves the config surface entirely');
  });

  it('v4 -> v5: a non-boolean semantic value is a named config error, not silently dropped', () => {
    const configPath = writeRaw({ version: 4, presets: { default: { include: ['*.md'], semantic: { type: 'api' } } }, queries: {} });
    assert.throws(() => loadConfig(configPath), /presets\.default\.semantic must be a boolean/);
  });

  it('v3 -> v5: an api embed block keeps model, url and key verbatim; type renames to provider', () => {
    const v3Embed = { model: 'custom/m', type: 'api', url: 'http://localhost:11434/v1', key: 'MY_KEY' };
    const configPath = writeRaw({ version: 3, presets: { default: { include: ['*.md'] } }, embed: v3Embed, queries: {} });
    const resolved = loadConfig(configPath);
    assert.deepEqual(resolved.embed, { model: 'custom/m', url: 'http://localhost:11434/v1', key: 'MY_KEY', provider: 'openai' });
  });

  it('v4 -> v5: embed.type renames to embed.provider, "api" auto-migrating to "openai"', () => {
    const configPath = writeRaw({ version: 4, presets: { default: { include: ['*.md'] } }, embed: { model: 'custom/m', type: 'api', url: 'http://localhost:11434/v1' }, queries: {} });
    const resolved = loadConfig(configPath);
    assert.equal(resolved.migratedFrom, 4);
    assert.deepEqual(resolved.embed, { model: 'custom/m', url: 'http://localhost:11434/v1', provider: 'openai' });
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(onDisk.version, SUPPORTED_CONFIG_VERSION);
    assert.deepEqual(onDisk.embed, { model: 'custom/m', url: 'http://localhost:11434/v1', provider: 'openai' });
  });

  it('v4 -> v5: embed.type "static" carries straight over to provider "static"', () => {
    const configPath = writeRaw({ version: 4, presets: { default: { include: ['*.md'] } }, embed: { model: DEFAULT_EMBED_MODEL, type: 'static' }, queries: {} });
    const resolved = loadConfig(configPath);
    assert.deepEqual(resolved.embed, { model: DEFAULT_EMBED_MODEL, provider: 'static' });
  });

  it('v4 -> v5: no embed block stays absent', () => {
    const configPath = writeRaw({ version: 4, presets: { default: { include: ['*.md'], semantic: false } }, queries: {} });
    const resolved = loadConfig(configPath);
    assert.equal(resolved.embed, undefined);
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
