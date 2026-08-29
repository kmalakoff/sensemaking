import assert from 'node:assert';
import { basenameImpl, hasImpl } from '../../../src/store/sql-functions.ts';

describe('hasImpl', () => {
  it('NULL/undefined field is false', () => {
    assert.equal(hasImpl(null, 'x'), 0);
    assert.equal(hasImpl(undefined, 'x'), 0);
  });

  it('a JSON-array-shaped string field matches by membership', () => {
    assert.equal(hasImpl('["a","b"]', 'a'), 1);
    assert.equal(hasImpl('["a","b"]', 'c'), 0);
  });

  it('a plain string field matches by substring', () => {
    assert.equal(hasImpl('hello world', 'world'), 1);
    assert.equal(hasImpl('hello world', 'xyz'), 0);
  });

  it('a non-string field is stringified before matching', () => {
    assert.equal(hasImpl(42, '4'), 1);
  });
});

describe('basenameImpl', () => {
  it('NULL/undefined path is null', () => {
    assert.equal(basenameImpl(null), null);
    assert.equal(basenameImpl(undefined), null);
  });

  it('returns the filename with no suffix given', () => {
    assert.equal(basenameImpl('notes/a.md'), 'a.md');
  });

  it('strips a trailing suffix that is not the whole name', () => {
    assert.equal(basenameImpl('notes/a.md', '.md'), 'a');
  });

  it('does not strip a suffix identical to the whole name', () => {
    assert.equal(basenameImpl('notes/.md', '.md'), '.md');
  });
});
