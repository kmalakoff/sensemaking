import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMPARISON_CLASSES, ROWS } from '../../benchmark/lib/rows.mjs';
import { packageRoot, scratchDir } from '../lib/scratch.ts';

describe('documented shape sweep', () => {
  it('keeps one classified 26-row catalog with explicit output-size units', () => {
    assert.equal(ROWS.length, 26);
    assert.equal(new Set(ROWS.map(({ key }) => key)).size, ROWS.length);
    for (const row of ROWS) assert.ok(row.comparison_class in COMPARISON_CLASSES, `${row.key} comparison class`);
    const outputRows = ROWS.filter(({ kind }) => kind === 'tokens');
    assert.ok(outputRows.length > 0);
    for (const row of outputRows) {
      assert.equal(row.comparison_class, 'output-contract');
      assert.match(row.label, /UTF-16 code units \/ 4/);
    }
    for (const key of ['find_ms', 'words_ms', 'semantic_find_ms', 'cold_embed_ms']) assert.equal(ROWS.find((row) => row.key === key)?.comparison_class, 'native-diagnostic');
  });

  it('uses current presets and retains valid small-fixture repetitions', function () {
    this.timeout(30_000);
    const out = join(scratchDir('sweep-smoke'), 'rows.jsonl');
    const result = spawnSync(process.execPath, [join(packageRoot, 'benchmark/tools/sweep.mjs'), 'notes', '--smoke', '--out', out], {
      cwd: packageRoot,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(result.error, undefined, result.error?.message ?? 'sweep process failed');
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    const rows = readFileSync(out, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      rows.map(({ params }) => params.notes),
      [4, 8]
    );
    for (const row of rows) {
      assert.equal(row.dimension, 'notes');
      for (const value of Object.values(row.metrics)) assert.ok(typeof value === 'number' && Number.isFinite(value) && value >= 0);
    }
  });

  it('rejects an unknown dimension before measuring', () => {
    const result = spawnSync(process.execPath, [join(packageRoot, 'benchmark/tools/sweep.mjs'), 'not-a-dimension', '--smoke'], { cwd: packageRoot, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown dimension/);
  });
});
