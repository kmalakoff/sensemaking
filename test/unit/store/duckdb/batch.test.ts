import assert from 'node:assert';
import { rewriteBatch, rewriteDelete, rewriteInsert, rewriteUpdate } from '../../../../src/store/duckdb/batch.ts';

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

describe('rewriteUpdate', () => {
  it('turns a single SET/WHERE column pair into a VALUES-joined statement', () => {
    const result = rewriteUpdate('UPDATE frontmatter SET "_rank" = ? WHERE "path" = ?', 2);
    assert.equal(result?.width, 2);
    assert.equal(result?.sql, 'UPDATE frontmatter SET "_rank" = data."_rank" FROM (VALUES (?, ?), (?, ?)) AS data("_rank", "path") WHERE frontmatter."path" = data."path"');
  });

  it('handles a compound AND WHERE clause', () => {
    const result = rewriteUpdate('UPDATE links SET dst = ? WHERE src = ? AND target = ?', 1);
    assert.equal(result?.width, 3);
    assert.equal(result?.sql, 'UPDATE links SET dst = data.dst FROM (VALUES (?, ?, ?)) AS data(dst, src, target) WHERE links.src = data.src AND links.target = data.target');
  });

  it('is null for SQL with no WHERE clause', () => {
    assert.equal(rewriteUpdate('UPDATE t SET a = ?', 2), null);
  });
});

describe('rewriteDelete', () => {
  it('turns a single-column equality WHERE into an IN list', () => {
    const result = rewriteDelete('DELETE FROM tags WHERE "path" = ?', 3);
    assert.equal(result?.width, 1);
    assert.equal(result?.sql, 'DELETE FROM tags WHERE "path" IN (?, ?, ?)');
  });

  it('turns a compound AND WHERE into a row-tuple IN (VALUES ...)', () => {
    const result = rewriteDelete('DELETE FROM links WHERE src = ? AND target = ? AND embed = ?', 2);
    assert.equal(result?.width, 3);
    assert.equal(result?.sql, 'DELETE FROM links WHERE (src, target, embed) IN (VALUES (?, ?, ?), (?, ?, ?))');
  });

  it('is null for SQL with no WHERE clause', () => {
    assert.equal(rewriteDelete('DELETE FROM t', 2), null);
  });
});

describe('rewriteBatch', () => {
  it('tries INSERT, then UPDATE, then DELETE, in that order', () => {
    assert.ok(rewriteBatch('INSERT INTO t (a) VALUES (?)', 2)?.sql.startsWith('INSERT'));
    assert.ok(rewriteBatch('UPDATE t SET a = ? WHERE b = ?', 2)?.sql.startsWith('UPDATE'));
    assert.ok(rewriteBatch('DELETE FROM t WHERE a = ?', 2)?.sql.startsWith('DELETE'));
  });

  it('is null for a shape none of the three rewriters recognize', () => {
    assert.equal(rewriteBatch('INSERT INTO t SELECT ?', 2), null);
  });
});
