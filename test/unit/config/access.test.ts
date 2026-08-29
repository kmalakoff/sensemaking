import assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runCli as spawnCli } from '../../lib/cli.ts';
import { writeModel } from '../../lib/model.ts';
import { scratchDir } from '../../lib/scratch.ts';

// Follows the embed-identity signature pattern in db/open.test.ts: simulate a stale on-disk
// signature, then prove the next open() rebuilds instead of adopting it silently.

function runCli(dir: string, args: string[]) {
  return spawnCli([...args, '--config', join(dir, 'sense.config.json')]);
}

describe('D8 migration: chunk version in the feature signature', () => {
  it('the embed segment carries a chunk-version token', () => {
    const model = writeModel();
    const dir = scratchDir('chunk-sig');
    writeFileSync(join(dir, 'sense.config.json'), JSON.stringify({ version: 5, presets: { default: { include: ['*.md'] } }, embed: { model, provider: 'static' }, queries: {} }));
    writeFileSync(join(dir, 'a.md'), '---\ntitle: A\n---\n\napple\n');
    assert.equal(runCli(dir, ['sql', 'SELECT 1']).status, 0);

    const cachePath = join(dir, '.sense', 'cache.db');
    const db = new DatabaseSync(cachePath, { readOnly: true });
    const features = (db.prepare(`SELECT value FROM meta WHERE key = 'features'`).get() as { value: string }).value;
    db.close();
    assert.match(features, /embed:static:[^|]+:chunk:v\d+/, features);
  });

  it('a cache signature without the chunk token rebuilds on next open, even with an unchanged model', () => {
    const model = writeModel();
    const dir = scratchDir('chunk-sig');
    writeFileSync(join(dir, 'sense.config.json'), JSON.stringify({ version: 5, presets: { default: { include: ['*.md'] } }, embed: { model, provider: 'static' }, queries: {} }));
    writeFileSync(join(dir, 'a.md'), '---\ntitle: A\n---\n\napple\n');
    assert.equal(runCli(dir, ['sql', 'SELECT 1']).status, 0);

    const cachePath = join(dir, '.sense', 'cache.db');
    const setup = new DatabaseSync(cachePath);
    // A real (non-NULL) vector, so its absence below proves the row was actually rebuilt.
    setup.prepare(`UPDATE embeddings SET scale = 1.0, vector = X'2A' WHERE "path" = 'a.md' AND chunk = 0`).run();
    const before = (setup.prepare(`SELECT value FROM meta WHERE key = 'features'`).get() as { value: string }).value;
    assert.match(before, /:chunk:v\d+/, 'the fixture is expected to already carry a chunk-version token');
    // Simulate a pre-W3 cache: the 0.16.0 signature format, with no chunk token at all.
    setup.prepare(`UPDATE meta SET value = ? WHERE key = 'features'`).run(before.replace(/:chunk:v\d+/, ''));
    setup.close();

    const result = runCli(dir, ['sql', 'SELECT 1']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /config change \(embed settings\) rebuilds the index/);

    const after = new DatabaseSync(cachePath, { readOnly: true });
    const row = after.prepare(`SELECT vector FROM embeddings WHERE "path" = 'a.md' AND chunk = 0`).get() as { vector: Uint8Array | null } | undefined;
    after.close();
    assert.equal(row?.vector, null, 'the sentinel vector must not survive -- the row was rebuilt, not silently kept');
  });

  it('embed.chunkTokens appends its value onto the chunk-version token', () => {
    const model = writeModel();
    const dir = scratchDir('chunk-sig');
    writeFileSync(join(dir, 'sense.config.json'), JSON.stringify({ version: 5, presets: { default: { include: ['*.md'] } }, embed: { model, provider: 'static', chunkTokens: 100 }, queries: {} }));
    writeFileSync(join(dir, 'a.md'), '---\ntitle: A\n---\n\napple\n');
    assert.equal(runCli(dir, ['sql', 'SELECT 1']).status, 0);

    const cachePath = join(dir, '.sense', 'cache.db');
    const db = new DatabaseSync(cachePath, { readOnly: true });
    const features = (db.prepare(`SELECT value FROM meta WHERE key = 'features'`).get() as { value: string }).value;
    db.close();
    assert.match(features, /:chunk:v\d+:100(?:@|\||$)/, features);
  });

  it('setting, changing, or clearing embed.chunkTokens each rebuild the index', () => {
    const model = writeModel();
    const dir = scratchDir('chunk-sig');
    const configPath = join(dir, 'sense.config.json');
    const writeCfg = (chunkTokens?: number) => writeFileSync(configPath, JSON.stringify({ version: 5, presets: { default: { include: ['*.md'] } }, embed: { model, provider: 'static', ...(chunkTokens !== undefined ? { chunkTokens } : {}) }, queries: {} }));

    writeCfg(undefined);
    writeFileSync(join(dir, 'a.md'), '---\ntitle: A\n---\n\napple\n');
    assert.equal(runCli(dir, ['sql', 'SELECT 1']).status, 0);

    const cachePath = join(dir, '.sense', 'cache.db');
    const sentinel = () => {
      const db = new DatabaseSync(cachePath);
      db.prepare(`UPDATE embeddings SET scale = 1.0, vector = X'2A' WHERE "path" = 'a.md' AND chunk = 0`).run();
      db.close();
    };
    const vectorSurvived = () => {
      const db = new DatabaseSync(cachePath, { readOnly: true });
      const row = db.prepare(`SELECT vector FROM embeddings WHERE "path" = 'a.md' AND chunk = 0`).get() as { vector: Uint8Array | null } | undefined;
      db.close();
      return row?.vector != null;
    };

    // unset -> 100: a lever set for the first time must rebuild.
    sentinel();
    writeCfg(100);
    let result = runCli(dir, ['sql', 'SELECT 1']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /config change \(embed settings\) rebuilds the index/);
    assert.equal(vectorSurvived(), false, 'unset -> 100 must rebuild');

    // 100 -> 200: changing the value must rebuild too, not just setting it once.
    sentinel();
    writeCfg(200);
    result = runCli(dir, ['sql', 'SELECT 1']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /config change \(embed settings\) rebuilds the index/);
    assert.equal(vectorSurvived(), false, '100 -> 200 must rebuild');

    // 200 -> unset: removing the lever must rebuild rather than silently reusing stale chunks.
    sentinel();
    writeCfg(undefined);
    result = runCli(dir, ['sql', 'SELECT 1']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /config change \(embed settings\) rebuilds the index/);
    assert.equal(vectorSurvived(), false, '200 -> unset must rebuild');
  });
});
