import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';
import { runDuckdbLexicalCost } from '../../benchmark/lib/duckdb-lexical-cost.mjs';
import { identityHash } from '../../benchmark/lib/workload-identity.mjs';
import { createConnection } from '../../src/store/duckdb/connection.ts';
import { createLexicalIndex } from '../../src/store/duckdb/lexical.ts';
import { registerFunctions } from '../../src/store/duckdb/sql-functions.ts';

describe('duckdb lexical cost diagnostic', () => {
  it('prints help and rejects unknown arguments before running the diagnostic', () => {
    const root = join(import.meta.dirname, '..', '..');
    const tool = join(root, 'benchmark', 'tools', 'duckdb-lexical-cost.mjs');
    const help = spawnSync(process.execPath, [tool, '--help'], { cwd: root, encoding: 'utf8' });
    assert.equal(help.error, undefined, help.error?.message ?? 'help spawn failed');
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stderr, /usage: node benchmark\/tools\/duckdb-lexical-cost\.mjs/);
    const unknown = spawnSync(process.execPath, [tool, '--unknown'], { cwd: root, encoding: 'utf8' });
    assert.equal(unknown.error, undefined, unknown.error?.message ?? 'unknown-argument spawn failed');
    assert.equal(unknown.status, 2, unknown.stderr);
    assert.match(unknown.stderr, /Unknown option '--unknown'/);
  });

  it('requires built DuckDB adapter exports used by the diagnostic tool', async () => {
    const root = join(import.meta.dirname, '..', '..');
    const [{ createConnection: builtConnection }, { createLexicalIndex: builtLexical }, { registerFunctions: builtFunctions }] = await Promise.all([
      import(pathToFileURL(join(root, 'dist', 'esm', 'store', 'duckdb', 'connection.js')).href),
      import(pathToFileURL(join(root, 'dist', 'esm', 'store', 'duckdb', 'lexical.js')).href),
      import(pathToFileURL(join(root, 'dist', 'esm', 'store', 'duckdb', 'sql-functions.js')).href),
    ]);
    assert.equal(typeof builtConnection, 'function');
    assert.equal(typeof builtLexical, 'function');
    assert.equal(typeof builtFunctions, 'function');
  });

  it('records bounded real-method samples with independently authored lexical expectations', async function () {
    this.timeout(60_000);
    const artifact = await runDuckdbLexicalCost({ DuckDBInstance, createConnection, createLexicalIndex, registerFunctions });
    assert.equal(artifact.valid, true, artifact.errors.join('\n'));
    assert.equal(artifact.status, 'success');
    assert.equal(artifact.timing_evidence, 'timer-only diagnostic; callers need separate machine-readiness evidence before treating samples as clean performance evidence');
    assert.deepEqual(artifact.fixture.expectations, {
      bare: ['adjacent.md', 'field-boundary.md', 'folded.md', 'punctuation.md', 'reversed.md'],
      phrase: ['adjacent.md', 'folded.md', 'punctuation.md'],
      scoped_phrase: ['punctuation.md'],
    });
    assert.deepEqual(artifact.fixture.row_counts, { 6: 6, 500: 500 });
    assert.deepEqual(artifact.fixture.procedure, {
      warmup_query_order: ['bare', 'phrase', 'scoped_phrase'],
      measured_query_orders: {
        1: ['bare', 'phrase', 'scoped_phrase'],
        2: ['phrase', 'scoped_phrase', 'bare'],
        3: ['scoped_phrase', 'bare', 'phrase'],
      },
    });
    const { fingerprint, ...fixtureIdentity } = artifact.fixture;
    assert.equal(fingerprint, identityHash(fixtureIdentity), 'the fixture fingerprint must cover the warmup and measured-order procedure');
    assert.equal(artifact.samples.length, 6);

    for (const sample of artifact.samples) {
      if ('error' in sample) assert.fail(sample.error ?? 'DuckDB lexical cost sample failed');
      assert.ok(sample.queries);
      assert.ok(sample.native);
      assert.deepEqual(sample.state, { database: 'fresh', index: 'warm', query_shapes: 'warm' });
      assert.deepEqual(sample.warmup_query_order, ['bare', 'phrase', 'scoped_phrase']);
      assert.deepEqual(sample.measured_query_order, artifact.fixture.procedure.measured_query_orders[sample.repetition]);
      assert.deepEqual(
        sample.queries.map(({ id }) => id),
        sample.measured_query_order
      );
      assert.equal(sample.fixture_rows, sample.notes);
      assert.equal(sample.indexed_row_count, sample.notes);
      assert.equal(sample.queries.length, 3);
      assert.equal(sample.native.version_query, 'SELECT version() AS version');
      assert.equal(typeof sample.native.version, 'string');
      for (const query of sample.queries) {
        assert.deepEqual([...query.actual_paths].sort(), [...query.expected_paths].sort(), query.id);
        for (const timing of [query.total_ms, query.prepare_ms, query.execute_read_convert_ms, query.outside_connection_ms]) {
          assert.equal(Number.isFinite(timing), true);
          assert.ok(timing >= 0);
        }
        assert.match(query.limitation, /not pure native execution/);
      }
    }
  });
});
