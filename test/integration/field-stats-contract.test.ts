import assert from 'node:assert';
import { forEachStore, withTreeForStore } from '../lib/stores.ts';
import { tmpTree, writeNote } from '../lib/tree.ts';

function fieldStatsTree() {
  const baseDir = tmpTree();
  writeNote(baseDir, 'a.md', { frontmatter: { title: 'Alpha', priority: 5, mixed: 1, nullable: null, missing: null } });
  writeNote(baseDir, 'b.md', { frontmatter: { title: 'Beta', priority: 7, mixed: 'high', nullable: 'present' } });
  writeNote(baseDir, 'c.md', { frontmatter: { title: 'Gamma' } });
  return baseDir;
}

describe('field stats contract', () => {
  it('reports exact coverage and the shared type vocabulary for every store', async () => {
    await forEachStore(async (store) => {
      await withTreeForStore(store, fieldStatsTree(), async ({ store: opened }) => {
        assert.deepEqual(await opened.docs.fieldStats(['title', 'priority', 'mixed', 'nullable', 'missing'], ''), [
          { field: 'title', coverage: 3, type: 'text' },
          { field: 'priority', coverage: 2, type: 'integer' },
          { field: 'mixed', coverage: 2, type: 'integer,text' },
          { field: 'nullable', coverage: 1, type: 'text' },
          { field: 'missing', coverage: 0, type: '' },
        ]);
      });
    });
  });

  it('applies scope before computing both coverage and observed types', async () => {
    await forEachStore(async (store) => {
      await withTreeForStore(store, fieldStatsTree(), async ({ store: opened }) => {
        assert.deepEqual(await opened.docs.fieldStats(['mixed', 'nullable', 'missing'], `WHERE "path" = 'a.md'`), [
          { field: 'mixed', coverage: 1, type: 'integer' },
          { field: 'nullable', coverage: 0, type: '' },
          { field: 'missing', coverage: 0, type: '' },
        ]);
      });
    });
  });

  it('returns zero coverage and no observed type for an empty scope', async () => {
    await forEachStore(async (store) => {
      await withTreeForStore(store, fieldStatsTree(), async ({ store: opened }) => {
        assert.deepEqual(await opened.docs.fieldStats(['title', 'missing'], 'WHERE 0 = 1'), [
          { field: 'title', coverage: 0, type: '' },
          { field: 'missing', coverage: 0, type: '' },
        ]);
      });
    });
  });
});
