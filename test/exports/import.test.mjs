import assert from 'node:assert';
import { loadConfig, open, SenseError, search } from 'sensemaking';

describe('exports .mjs', () => {
  it('named exports resolve through the esm condition', () => {
    for (const fn of [loadConfig, open, search]) assert.equal(typeof fn, 'function');
    assert.equal(typeof SenseError, 'function');
  });
});
