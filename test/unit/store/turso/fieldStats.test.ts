import assert from 'node:assert';
import { openConfig, tmpTree, writeNote } from '../../../lib/tree.ts';

function tursoTree(baseDir: string) {
  return openConfig({ store: 'turso', presets: { default: { include: ['**/*.md'] } }, queries: {}, baseDir, configPath: null } as Parameters<typeof openConfig>[0]);
}

describe('fieldStats (turso)', () => {
  it('aggregates coverage and observed type in SQL: a text field, an integer field, a mixed-type field, and a field null in some notes', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'Alpha', priority: 5, mixed: 1 } });
    writeNote(baseDir, 'b.md', { frontmatter: { title: 'Beta', priority: 7, mixed: 'high' } });
    writeNote(baseDir, 'c.md', { frontmatter: { title: 'Gamma' } }); // priority, mixed absent -- null in this note
    const { store } = await tursoTree(baseDir);
    const stats = await store.docs.fieldStats(['title', 'priority', 'mixed'], '');
    const byField = Object.fromEntries(stats.map((s) => [s.field, s]));
    // Turso is SQLite dialect (spike-verified: typeof(), GROUP_CONCAT, and FILTER (WHERE ...)
    // all behave like node:sqlite), so this is the same vocabulary sqlite emits, unmapped.
    assert.deepEqual(byField.title, { field: 'title', coverage: 3, type: 'text' });
    assert.deepEqual(byField.priority, { field: 'priority', coverage: 2, type: 'integer' });
    assert.deepEqual(byField.mixed, { field: 'mixed', coverage: 2, type: 'integer,text' });
    await store.close();
  });

  it('scopeWhere narrows both coverage and the observed type set to the matching rows', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { mixed: 1 } });
    writeNote(baseDir, 'b.md', { frontmatter: { mixed: 'high' } });
    const { store } = await tursoTree(baseDir);
    const stats = await store.docs.fieldStats(['mixed'], `WHERE "path" = 'a.md'`);
    assert.deepEqual(stats, [{ field: 'mixed', coverage: 1, type: 'integer' }]);
    await store.close();
  });
});
