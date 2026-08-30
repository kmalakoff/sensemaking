import assert from 'node:assert';
import { openConfig, tmpTree, writeNote } from '../../../lib/tree.ts';

function duckdbTree(baseDir: string) {
  return openConfig({ store: 'duckdb', presets: { default: { include: ['**/*.md'] } }, queries: {}, baseDir, configPath: null } as Parameters<typeof openConfig>[0]);
}

describe('fieldStats (duckdb)', () => {
  it('aggregates coverage and observed type in SQL: a text field, an integer field, a mixed-type field, and a field null in some notes', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'Alpha', priority: 5, mixed: 1 } });
    writeNote(baseDir, 'b.md', { frontmatter: { title: 'Beta', priority: 7, mixed: 'high' } });
    writeNote(baseDir, 'c.md', { frontmatter: { title: 'Gamma' } }); // priority, mixed absent -- null in this note
    const { store } = await duckdbTree(baseDir);
    const stats = await store.docs.fieldStats(['title', 'priority', 'mixed'], '');
    const byField = Object.fromEntries(stats.map((s) => [s.field, s]));
    // Same shared vocabulary sqlite's typeof() emits, even though variant_typeof() reports
    // DuckDB-native names (INT128/DOUBLE/VARCHAR) underneath -- the mapping in fieldStats.ts.
    assert.deepEqual(byField.title, { field: 'title', coverage: 3, type: 'text' });
    assert.deepEqual(byField.priority, { field: 'priority', coverage: 2, type: 'integer' });
    assert.deepEqual(byField.mixed, { field: 'mixed', coverage: 2, type: 'integer,text' });
    await store.close();
  });

  it('scopeWhere narrows both coverage and the observed type set to the matching rows', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { mixed: 1 } });
    writeNote(baseDir, 'b.md', { frontmatter: { mixed: 'high' } });
    const { store } = await duckdbTree(baseDir);
    const stats = await store.docs.fieldStats(['mixed'], `WHERE "path" = 'a.md'`);
    assert.deepEqual(stats, [{ field: 'mixed', coverage: 1, type: 'integer' }]);
    await store.close();
  });

  it('throws naming the unrecognized type when variant_typeof() reports something outside the mapped vocabulary', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { flag: 1 } });
    const { store } = await duckdbTree(baseDir);
    // mapValue() never binds a native boolean (booleans go through as bigint 0/1), so this
    // reaches the unmapped branch the only way it can occur: a raw write past mapValue.
    await store.exec(`UPDATE frontmatter SET flag = true WHERE "path" = 'a.md'`);
    await assert.rejects(
      () => store.docs.fieldStats(['flag'], ''),
      (err: Error) => {
        assert.match(err.message, /unrecognized type "BOOL_TRUE" for column "flag"/);
        return true;
      }
    );
    await store.close();
  });
});
