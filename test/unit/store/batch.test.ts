import assert from 'node:assert';
import { rewriteInsert } from '../../../src/store/batch.ts';

describe('rewriteInsert', () => {
  it('repeats the VALUES tuple N times and reports the per-row placeholder width', () => {
    const result = rewriteInsert('INSERT INTO t (a, b) VALUES (?, ?)', 3);
    assert.equal(result?.width, 2);
    assert.equal(result?.sql, 'INSERT INTO t (a, b) VALUES (?, ?), (?, ?), (?, ?)');
  });

  it('preserves a literal (non-placeholder) value inside the tuple, and an ON CONFLICT tail', () => {
    const result = rewriteInsert('INSERT INTO links (src, target, dst, embed) VALUES (?, ?, NULL, ?) ON CONFLICT(src, target) DO UPDATE SET x = excluded.x', 2);
    assert.equal(result?.width, 3);
    assert.equal(result?.sql, 'INSERT INTO links (src, target, dst, embed) VALUES (?, ?, NULL, ?), (?, ?, NULL, ?) ON CONFLICT(src, target) DO UPDATE SET x = excluded.x');
  });

  it('is null for SQL with no VALUES clause', () => {
    assert.equal(rewriteInsert('UPDATE t SET a = ?', 3), null);
  });
});
