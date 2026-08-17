const assert = require('node:assert');
const { loadConfig, open, search, SenseError } = require('sensemaking');

// The cjs half of the dual build is otherwise unexercised: bin/cli.js reaches it whenever a
// consumer's tooling requires rather than imports, and nothing else here loads that path.
describe('exports .cjs', () => {
  it('named exports resolve through the require condition', () => {
    for (const fn of [loadConfig, open, search]) assert.equal(typeof fn, 'function');
    assert.equal(typeof SenseError, 'function');
  });
});
