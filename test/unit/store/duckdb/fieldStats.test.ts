import assert from 'node:assert';
import { openConfig, tmpTree, writeNote } from '../../../lib/tree.ts';

function duckdbTree(baseDir: string) {
  return openConfig({ store: 'duckdb', presets: { default: { include: ['**/*.md'] } }, queries: {}, baseDir, configPath: null } as Parameters<typeof openConfig>[0]);
}

describe('fieldStats (duckdb)', () => {
  it('throws naming the unrecognized type when variant_typeof() reports something outside the mapped vocabulary', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { flag: 1 } });
    const { store } = await duckdbTree(baseDir);
    try {
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
    } finally {
      await store.close();
    }
  });
});
