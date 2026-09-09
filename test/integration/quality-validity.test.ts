import assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readLabels } from '../../benchmark/lib/labels.mjs';
import { metricRangeError, metrics } from '../../benchmark/lib/metrics.mjs';
import { evaluateVariant } from '../../benchmark/lib/quality.mjs';
import { scratchDir } from '../lib/scratch.ts';
import { withTreeForStore } from '../lib/stores.ts';
import { writeNote } from '../lib/tree.ts';

function labelDir(queries: string, qrels: string): string {
  const dir = scratchDir('quality-label-validity');
  writeFileSync(join(dir, 'queries.jsonl'), queries);
  writeFileSync(join(dir, 'test.tsv'), qrels);
  return dir;
}

const HEADER = 'query-id\tcorpus-id\tscore\n';

describe('quality metric validity', () => {
  it('accepts fractional grades and legitimate empty rankings or qrels', () => {
    assert.equal(metricRangeError('ndcg', 0.5), null);
    assert.equal(metricRangeError('rr', 0), null);
    assert.equal(metricRangeError('hit', 1), null);
    assert.deepEqual(metrics([], new Map(), 10), { ndcg: 0, rr: 0, hit: 0 });
    assert.deepEqual(metrics(['doc'], new Map([['doc', 0.5]]), 1), { ndcg: 1, rr: 1, hit: 1 });
  });

  it('rejects malformed grades and out-of-range metric values before scoring', () => {
    assert.match(metricRangeError('ndcg', Number.NaN) ?? '', /finite/);
    assert.match(metricRangeError('rr', -0.1) ?? '', /between/);
    assert.match(metricRangeError('hit', 1.1) ?? '', /between/);
    assert.throws(() => metrics(['doc'], new Map([['doc', -1]]), 1), /malformed grade/);
    assert.throws(() => metrics(['doc'], new Map([['doc', Number.POSITIVE_INFINITY]]), 1), /malformed grade/);
    assert.throws(() => metrics([], new Map([['doc', 1024]]), 1), /non-finite gain/);
  });

  it('rejects duplicate normalized ranked IDs and reports the query without scoring it', async () => {
    const baseDir = scratchDir('quality-duplicate-ranking');
    writeNote(baseDir, 'doc.md', { body: 'query' });
    let calls = 0;
    const result = await withTreeForStore('sqlite', baseDir, async ({ store }) =>
      evaluateVariant({
        qids: ['q1'],
        queries: new Map([['q1', 'query']]),
        qrels: new Map([['q1', new Map([['doc', 1]])]]),
        k: 2,
        search: async () => {
          calls++;
          return (await (await store.prepare('SELECT "path" FROM frontmatter UNION ALL SELECT replace("path", \'.md\', \'\') AS "path" FROM frontmatter')).all()) as Array<{ path: string }>;
        },
      })
    );
    assert.equal(calls, 1);
    assert.equal(result.perQuery.size, 0);
    assert.equal(result.incomplete, true);
    assert.match(result.errorDetails[0].error, /duplicate id/);
  });

  it('keeps missing query text and qrels as named incomplete failures', async () => {
    const baseDir = scratchDir('quality-preflight');
    writeNote(baseDir, 'doc.md', { body: 'query' });
    await withTreeForStore('sqlite', baseDir, async ({ store }) => {
      const searchRows = async () => (await (await store.prepare('SELECT "path" FROM frontmatter')).all()) as Array<{ path: string }>;
      const noText = await evaluateVariant({ qids: ['q1'], queries: new Map([['q1', '']]), qrels: new Map([['q1', new Map()]]), k: 1, search: searchRows });
      assert.equal(noText.errorDetails[0].error, 'missing query text');
      const noQrels = await evaluateVariant({ qids: ['q1'], queries: new Map([['q1', 'query']]), qrels: new Map(), k: 1, search: searchRows });
      assert.equal(noQrels.errorDetails[0].error, 'missing qrels for query');
    });
  });

  it('reads valid labels with numeric query IDs and rejects strict label corruption', () => {
    const valid = readLabels(labelDir('{"_id": 7, "text": "query"}\n', HEADER));
    assert.equal(valid.queries.get('7'), 'query');
    assert.equal(valid.qrels.size, 0);

    const cases: Array<[string, string, RegExp]> = [
      ['{"_id":"q1","text":"query"}\n{"_id":"q1","text":"again"}\n', `${HEADER}q1\tdoc\t1\n`, /repeats query id/],
      ['{"_id":"q1"}\n', `${HEADER}q1\tdoc\t1\n`, /missing query text/],
      ['{"text":"query"}\n', `${HEADER}q1\tdoc\t1\n`, /missing a nonempty _id/],
      ['{"_id":"q1","text":"query"}\n', `${HEADER}q1\tdoc\t1\nq1\tdoc\t0.5\n`, /repeats qrel/],
      ['{"_id":"q1","text":"query"}\n', `${HEADER}missing\tdoc\t1\n`, /missing query id/],
      ['{"_id":"q1","text":"query"}\n', `${HEADER}q1\tdoc\t \n`, /malformed score/],
      ['{"_id":"q1","text":"query"}\n', `${HEADER}q1\tdoc\t-1\n`, /malformed score/],
    ];
    for (const [queries, qrels, reason] of cases) assert.throws(() => readLabels(labelDir(queries, qrels)), reason);
  });
});
