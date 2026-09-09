import assert from 'node:assert';
import { connect, type Database } from '@tursodatabase/database';
import type { SenseError } from '../../../../src/errors.ts';
import { basenameImpl, hasImpl } from '../../../../src/store/sql-functions.ts';
import { rewriteFunctions } from '../../../../src/store/turso/sql-functions.ts';

function openConn(): Promise<Database> {
  return connect(':memory:', {});
}

async function scalar<T>(db: Database, sql: string, ...params: unknown[]): Promise<T> {
  const stmt = await db.prepare(rewriteFunctions(sql));
  const row = (await stmt.get(...params)) as Record<string, T>;
  return row[Object.keys(row)[0]];
}

describe('rewriteFunctions (turso): passthrough', () => {
  it('leaves SQL with no has()/basename()/segment() call untouched', () => {
    const sql = `SELECT "path" FROM frontmatter WHERE title = 'has fun'`;
    assert.equal(rewriteFunctions(sql), sql);
  });

  it('does not rewrite the words inside a string literal or a comment', () => {
    const sql = `SELECT 'call has(x,y) here' AS a, "path" FROM frontmatter -- basename(x) in a comment\nWHERE 1=1`;
    assert.equal(rewriteFunctions(sql), sql);
  });

  it('does not rewrite an identifier that merely contains "has" or "basename"', () => {
    const sql = 'SELECT hasSomething, mybasename FROM t';
    assert.equal(rewriteFunctions(sql), sql);
  });
});

describe('rewriteFunctions (turso): has() matches the shared implementation', () => {
  const cases: Array<[unknown, unknown]> = [
    [null, 'x'],
    ['["a","b"]', 'a'],
    ['["a","b"]', 'c'],
    ['hello world', 'world'],
    ['hello world', 'xyz'],
    [42, '4'],
    ['[not json', 'not'],
    ['[]', 'a'],
  ];

  for (const [field, value] of cases) {
    it(`has(${JSON.stringify(field)}, ${JSON.stringify(value)}) agrees with hasImpl`, async () => {
      const db = await openConn();
      try {
        const got = await scalar<number>(db, 'SELECT has(?, ?) AS r', field, value);
        assert.equal(Number(got), hasImpl(field, value));
      } finally {
        await db.close();
      }
    });
  }
});

describe('rewriteFunctions (turso): basename() matches the shared implementation', () => {
  const cases: Array<[unknown, unknown]> = [
    [null, undefined],
    ['notes/a.md', undefined],
    ['notes/a.md', '.md'],
    ['notes/.md', '.md'],
    ['notes/a/', undefined],
    ['notes/a.md', 'toolongsuffix'],
  ];

  for (const [path, suffix] of cases) {
    it(`basename(${JSON.stringify(path)}, ${JSON.stringify(suffix)}) agrees with basenameImpl`, async () => {
      const db = await openConn();
      try {
        const sql = suffix === undefined ? 'SELECT basename(?) AS r' : 'SELECT basename(?, ?) AS r';
        const params = suffix === undefined ? [path] : [path, suffix];
        const got = await scalar<string | null>(db, sql, ...params);
        assert.equal(got, basenameImpl(path, suffix));
      } finally {
        await db.close();
      }
    });
  }

  it('resolves a call nested inside another function, like instr(basename(path), ...)', async () => {
    const db = await openConn();
    try {
      const got = await scalar<number>(db, `SELECT instr(basename('notes/Movie Template.md'), 'Template') AS r`);
      assert.ok(Number(got) > 0);
    } finally {
      await db.close();
    }
  });
});

// PRINCIPLES: no-silent-modes, modelled on turso/lexical.ts's rejected FTS5 operators.
describe('rewriteFunctions (turso): segment() has no SQL form and is rejected', () => {
  it('throws STORE_CAPABILITY_MISSING naming segment() and the sqlite fallback', () => {
    assert.throws(
      () => rewriteFunctions(`SELECT segment('东京') AS s`),
      (err: SenseError) => {
        assert.equal(err.code, 'STORE_CAPABILITY_MISSING');
        assert.match(err.message, /store "turso" does not implement segment\(\)/);
        assert.match(err.message, /"store" to "sqlite"/);
        return true;
      }
    );
  });

  it('is rejected even nested inside another call', () => {
    assert.throws(
      () => rewriteFunctions(`SELECT instr(segment('东京'), 'x') AS s`),
      (err: SenseError) => err.code === 'STORE_CAPABILITY_MISSING'
    );
  });
});
