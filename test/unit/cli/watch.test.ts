import assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../lib/cli.ts';
import { tmpTree, writeNote } from '../../lib/tree.ts';

// The capability gate runs before the store opens, so this needs no @duckdb/node-api.

describe('watch (cli)', () => {
  it('a duckdb tree exits nonzero and names the config fix', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md');
    writeFileSync(join(baseDir, 'sense.config.json'), JSON.stringify({ version: 5, store: 'duckdb', presets: { default: { include: ['**/*.md'] } }, queries: {} }));
    const result = runCli(['watch'], { cwd: baseDir });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /"store" to "sqlite"/);
  });
});
