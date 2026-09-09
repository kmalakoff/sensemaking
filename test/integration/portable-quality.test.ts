import assert from 'node:assert';
import { type SearchOptions, search } from 'sensemaking';
import { bareAnd, orBag } from '../../benchmark/lib/labels.mjs';
import { buildQualityArtifactBase, evaluateVariant, qualityVariantEvidence, queryFormFor } from '../../benchmark/lib/quality.mjs';
import { executionEvidence } from '../../benchmark/lib/workload-identity.mjs';
import { forEachStore, withTreeForStore } from '../lib/stores.ts';
import { tmpTree, writeNote } from '../lib/tree.ts';

function qualityTree(): string {
  const baseDir = tmpTree();
  writeNote(baseDir, 'both.md', { body: 'alpha beta shared' });
  writeNote(baseDir, 'alpha.md', { body: 'alpha only' });
  writeNote(baseDir, 'beta.md', { body: 'beta only' });
  writeNote(baseDir, 'zh-both.md', { body: '太阳行星' });
  writeNote(baseDir, 'zh-one.md', { body: '太空' });
  writeNote(baseDir, 'thai-both.md', { body: 'ค้นหา ข่าว' });
  writeNote(baseDir, 'thai-one.md', { body: 'ข้อมูล ข่าว' });
  return baseDir;
}

describe('portable quality query form', () => {
  it('freezes legacy OR-bag and portable bare-and spellings', () => {
    assert.equal(orBag('alpha beta'), 'alpha OR beta');
    assert.equal(orBag('太阳'), '太 OR 阳');
    assert.equal(orBag('ค้นหา'), 'ค OR น OR ห OR า');
    assert.equal(orBag('AND alpha OR beta'), 'alpha OR beta');
    assert.equal(orBag('alpha, beta!'), 'alpha OR beta');
    assert.equal(bareAnd('alpha beta'), 'alpha beta');
    assert.equal(bareAnd('太阳'), '太阳');
    assert.equal(bareAnd('ค้นหา'), 'ค้นหา');
  });

  it('records default and explicit query-form evidence through the shared builder', () => {
    const qids = ['q1'];
    const queries = new Map([['q1', 'alpha beta']]);
    const qrels = new Map([['q1', new Map([['both', 1]])]]);
    const defaults = buildQualityArtifactBase({ corpus: 'fixture', split: 'test', qids, k: 10, store: 'sqlite', source: 'source', tree: 'tree', measureVersion: 'test', queries, qrels, queryForm: 'or-bag', queryFor: queryFormFor() });
    const portable = buildQualityArtifactBase({ corpus: 'fixture', split: 'test', qids, k: 10, store: 'duckdb', source: 'source', tree: 'tree', measureVersion: 'test', queries, qrels, queryForm: 'bare-and', queryFor: queryFormFor('bare-and') });
    assert.equal(defaults.query_evidence.q1.canonical, 'alpha OR beta');
    assert.equal(portable.query_evidence.q1.canonical, 'alpha beta');
    assert.deepEqual(portable.qrels, { q1: { both: 1 } });
    assert.deepEqual(qualityVariantEvidence({ errors: 0, error_details: [], incomplete: false, ms: 0, perQuery: new Map() }).model_observation, { status: 'not-applicable' });
  });

  it('runs the same bare-and workload on every store', async () => {
    await forEachStore(async (name) => {
      const baseDir = qualityTree();
      await withTreeForStore(name, baseDir, async ({ store, cfg }) => {
        const qids = ['latin', 'unspaced', 'thai', 'empty'];
        const queries = new Map([
          ['latin', 'alpha beta'],
          ['unspaced', '太阳'],
          ['thai', 'ค้นหา'],
          ['empty', 'no such term'],
        ]);
        const qrels = new Map([
          ['latin', new Map([['both', 1]])],
          ['unspaced', new Map([['zh-both', 1]])],
          ['thai', new Map([['thai-both', 1]])],
          ['empty', new Map()],
        ]);
        const result = await evaluateVariant({ qids, queries, qrels, k: 10, search: (terms: string, options: SearchOptions) => search(store, cfg, terms, options), queryFor: bareAnd });
        assert.equal(result.incomplete, false, `${name}: bare-and fixture must evaluate completely`);
        assert.deepEqual(result.errorDetails, []);
        const evidence = qualityVariantEvidence({
          ...result,
          execution: { ...executionEvidence({ argv: ['quality', '--query-form', 'bare-and'], config: { store: name, embed: { model: 'fixture-model', provider: 'static', url: 'https://secret.example' } } }), invocation_kind: 'requested invocation projection' },
          model_observation: { provider: 'static', model: 'fixture-model', revision: 'unknown', resolved_identity: 'unverified' },
          errors: 0,
          error_details: [],
        });
        assert.deepEqual(evidence.per_query.latin.paths, ['both.md']);
        assert.deepEqual(evidence.per_query.thai.paths, ['thai-both.md']);
        assert.equal(evidence.execution.config.embed.model, 'fixture-model');
        assert.match(evidence.execution.config.embed.url.redacted_sha256, /^[0-9a-f]{64}$/);
        assert.equal(evidence.execution.invocation_kind, 'requested invocation projection');
        assert.deepEqual(evidence.model_observation, { provider: 'static', model: 'fixture-model', revision: 'unknown', resolved_identity: 'unverified' });
        assert.doesNotMatch(JSON.stringify(evidence), /secret\.example/);
        const paths = (qid: string): string[] => {
          const query = result.perQuery.get(qid);
          assert.ok(query, `${name}: missing evaluated query ${qid}`);
          return JSON.parse(query.rows).map((row: { path: string }) => row.path);
        };
        assert.deepEqual(paths('latin'), ['both.md'], `${name}: bare-and must require both Latin terms`);
        assert.deepEqual(paths('unspaced'), ['zh-both.md'], `${name}: bare-and must preserve the expected document query spelling`);
        assert.deepEqual(paths('thai'), ['thai-both.md'], `${name}: bare-and must preserve the expected Thai query spelling`);
        assert.deepEqual(paths('empty'), [], `${name}: a legitimate empty ranking must stay empty`);

        let calls = 0;
        const invalid = await evaluateVariant({
          qids: ['invalid-form'],
          queries: new Map([['invalid-form', 'AND OR']]),
          qrels: new Map([['invalid-form', new Map()]]),
          k: 10,
          search: (terms: string, options: SearchOptions) => {
            calls++;
            return search(store, cfg, terms, options);
          },
          queryFor: bareAnd,
        });
        assert.equal(calls, 0, `${name}: empty canonical query must fail before search`);
        assert.equal(invalid.incomplete, true);
        assert.deepEqual(invalid.errorDetails, [{ qid: 'invalid-form', error: 'query form produced an empty query' }]);
      });
    });
  });
});
