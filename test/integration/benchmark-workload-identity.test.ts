import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'assert';
import { canonicalJson } from '../../benchmark/lib/canonical-json.mjs';
import { syntheticSpecKey } from '../../benchmark/lib/corpus.mjs';
import { executionEvidence, identityHash, implementationProvenance, logicalWorkloadIdentity, manifestIdentity } from '../../benchmark/lib/workload-identity.mjs';
import { packageRoot, scratchDir } from '../lib/scratch.ts';

describe('benchmark workload identity', () => {
  it('preserves the canonical encoding and existing synthetic cache key', () => {
    assert.equal(canonicalJson({ z: [{ b: 2, a: 1 }], a: 'x' }), '{"a":"x","z":[{"a":1,"b":2}]}');
    assert.equal(syntheticSpecKey({ notes: 2, noteTokens: 3, seed: 7, presets: [{ name: 'z', dir: 'z', semantic: false }] }), 'synthetic-n2-t3-h8-l5-f30-fpn8-s7-9d9aae9e');
  });

  it('separates corpus bytes from mtimes and includes mtimes only for rows that observe them', () => {
    const first = [{ rel: 'a.md', bytes: 3, sha256: 'a'.repeat(64), mtimeMs: 1000 }];
    const retimed = [{ ...first[0], mtimeMs: 2000 }];
    const bytes = manifestIdentity(first);
    const retimedBytes = manifestIdentity(retimed);
    const state = manifestIdentity(first, { includeMtime: true });
    const retimedState = manifestIdentity(retimed, { includeMtime: true });
    assert.deepEqual(retimedBytes, bytes);
    assert.notEqual(retimedState.fingerprint, state.fingerprint);

    const contentOnly = logicalWorkloadIdentity({ corpus: bytes, operation: { row: 'find_ms', query: 'the' }, requested: { k: 10 } });
    const contentOnlyRetimed = logicalWorkloadIdentity({ corpus: retimedBytes, operation: { row: 'find_ms', query: 'the' }, requested: { k: 10 } });
    assert.equal(contentOnlyRetimed.fingerprint, contentOnly.fingerprint);
    const recent = logicalWorkloadIdentity({ corpus: bytes, operation: { row: 'map_ms' }, requested: {}, observableState: state });
    const recentRetimed = logicalWorkloadIdentity({ corpus: bytes, operation: { row: 'map_ms' }, requested: {}, observableState: retimedState });
    assert.notEqual(recentRetimed.fingerprint, recent.fingerprint);
  });

  it('keeps store, temporary paths, and implementation facts outside common logical inputs', () => {
    const corpus = { files: 1, bytes: 3, fingerprint: 'b'.repeat(64) };
    const logical = logicalWorkloadIdentity({ corpus, operation: { row: 'warm_query_ms', sql: 'SELECT 1' }, requested: { include: ['**/*.md'] } });
    const sqliteExecution = executionEvidence({ argv: ['sql', 'SELECT 1'], config: { store: 'sqlite', baseDir: '/tmp/a' } });
    const duckdbExecution = executionEvidence({ argv: ['sql', 'SELECT 1'], config: { store: 'duckdb', baseDir: '/tmp/b' } });
    assert.notEqual(sqliteExecution.config_fingerprint, duckdbExecution.config_fingerprint);
    assert.equal(logical.fingerprint, logicalWorkloadIdentity({ corpus, operation: { row: 'warm_query_ms', sql: 'SELECT 1' }, requested: { include: ['**/*.md'] } }).fingerprint);
  });

  it('changes logical IDs with actual config and safely roundtrips recorded inputs', () => {
    const corpus = { files: 1, bytes: 3, paths_fingerprint: 'a'.repeat(64), fingerprint: 'b'.repeat(64) };
    const words = logicalWorkloadIdentity({ corpus, operation: { row: 'find_ms', query: 'the' }, requested: { config: { presets: { lexical: { signals: { words: 1 } } } }, optional: undefined } });
    const fused = logicalWorkloadIdentity({ corpus, operation: { row: 'find_ms', query: 'the' }, requested: { config: { presets: { lexical: { signals: { words: 1, links: 1 } } } }, optional: undefined } });
    assert.notEqual(words.fingerprint, fused.fingerprint);
    const roundtripped = JSON.parse(JSON.stringify(words));
    assert.equal(roundtripped.fingerprint, identityHash(roundtripped.inputs));
    assert.ok(!('optional' in roundtripped.inputs.requested));
    assert.throws(() => logicalWorkloadIdentity({ corpus, operation: { row: 'find_ms', k: Number.NaN }, requested: {} }), /non-finite/);
  });

  it('redacts URL and key values while preserving opaque config identity', () => {
    const evidence = executionEvidence({ argv: ['search', 'the'], config: { embed: { url: 'https://user:secret@example.test', apiKey: 'top-secret', model: 'named' } } });
    const encoded = JSON.stringify(evidence);
    assert.doesNotMatch(encoded, /user:secret|top-secret/);
    assert.match(evidence.config.embed.url.redacted_sha256, /^[0-9a-f]{64}$/);
    assert.match(evidence.config.embed.apiKey.redacted_sha256, /^[0-9a-f]{64}$/);
    assert.equal(evidence.config.embed.model, 'named');
  });

  it('records an absent source tree without conflating it with the built distribution', () => {
    const published = scratchDir('published-package-layout');
    mkdirSync(join(published, 'dist'));
    writeFileSync(join(published, 'package.json'), JSON.stringify({ name: 'published-fixture', version: '1.2.3' }));
    writeFileSync(join(published, 'dist', 'index.js'), 'export const built = true;\n');
    const provenance = implementationProvenance({ packageRoot: published, harnessRoot: packageRoot, harnessFiles: ['benchmark/lib/workload-identity.mjs'], store: 'sqlite', nativeObservation: { function: 'sqlite_version()', value: 'fixture' }, modelObservation: { revision: 'unknown' } });
    assert.deepEqual(provenance.measured_package.source, { status: 'absent' });
    const dist = provenance.measured_package.dist;
    if (!('fingerprint' in dist)) assert.fail('expected the built distribution to be recorded');
    assert.notEqual(provenance.measured_package.package_json.fingerprint, dist.fingerprint);
  });
});
