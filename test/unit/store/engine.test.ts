import assert from 'assert';
import { SenseError } from '../../../src/errors.ts';
import { checkEngine, ENGINE_CHECK_QUERIES, type EnginePatch, npmRemedy, selectBuilders } from '../../../src/store/engine.ts';

interface Builders {
  a: () => string;
  b: () => string;
}
const DEFAULTS: Builders = { a: () => 'default a', b: () => 'default b' };

describe('selectBuilders', () => {
  it('keeps the defaults when no patch range matches', () => {
    const patches: EnginePatch<Builders>[] = [{ range: '>=2.0.0', reason: 'fixture', builders: { a: () => 'patched a' } }];
    const selected = selectBuilders(DEFAULTS, patches, '1.5.6');
    assert.equal(selected.a(), 'default a');
  });

  it('replaces only the patched builders for a matching prerelease version', () => {
    const patches: EnginePatch<Builders>[] = [{ range: '>=1.5.0 <1.6.0', reason: 'fixture', builders: { a: () => 'patched a' } }];
    const selected = selectBuilders(DEFAULTS, patches, '1.5.6-r.1');
    assert.equal(selected.a(), 'patched a');
    assert.equal(selected.b(), 'default b');
  });

  it('lets a later matching patch refine an earlier one', () => {
    const patches: EnginePatch<Builders>[] = [
      { range: '1.x', reason: 'broad', builders: { a: () => 'broad a', b: () => 'broad b' } },
      { range: '1.5.x', reason: 'narrow', builders: { a: () => 'narrow a' } },
    ];
    const selected = selectBuilders(DEFAULTS, patches, '1.5.6');
    assert.equal(selected.a(), 'narrow a');
    assert.equal(selected.b(), 'broad b');
  });

  it('applies no patch when the loaded version is unknown', () => {
    const patches: EnginePatch<Builders>[] = [{ range: '*', reason: 'fixture', builders: { a: () => 'patched a' } }];
    assert.equal(selectBuilders(DEFAULTS, patches, undefined).a(), 'default a');
  });
});

describe('checkEngine', () => {
  const expected = new Map(ENGINE_CHECK_QUERIES.map((q) => [q.terms, q.paths]));

  it('passes when every fixture query returns its expected paths', async () => {
    await checkEngine('fixture', 'fixture-pkg@1.0.0', npmRemedy('fixture-pkg', '^1.0.0'), async (terms) => expected.get(terms) ?? []);
  });

  it('names the identity, range, query, and result when a query returns the wrong order', async () => {
    await assert.rejects(
      () => checkEngine('fixture', 'fixture-pkg@1.0.0', npmRemedy('fixture-pkg', '^1.0.0'), async (terms) => [...(expected.get(terms) ?? [])].reverse()),
      (err: unknown) => {
        assert.ok(err instanceof SenseError);
        assert.equal(err.code, 'STORE_CAPABILITY_MISSING');
        assert.equal(err.message, 'store "fixture" cannot use fixture-pkg@1.0.0: searching "run" returned [b-text.md, z-title.md], expected [z-title.md, b-text.md]; run `npm install fixture-pkg@^1.0.0` for a tested version (tested ^1.0.0)');
        return true;
      }
    );
  });

  it('reports a query that throws as a failed check', async () => {
    await assert.rejects(
      () =>
        checkEngine('fixture', 'fixture-pkg@unknown', 'fixture remedy', async () => {
          throw new Error('no such function: fts_match');
        }),
      /store "fixture" cannot use fixture-pkg@unknown: searching "run" failed \(no such function: fts_match\); fixture remedy$/
    );
  });
});
