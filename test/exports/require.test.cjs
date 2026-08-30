const assert = require('node:assert');
const { CONFIG_FILENAME, clearCache, initConfig, loadConfig, mapTree, migrateConfig, open, peek, presetCoverage, printRows, runWatch, search, SenseError, SIGNAL_NAMES, STATE_DIR, SUPPORTED_CONFIG_VERSION } = require('sensemaking');

// The cjs half of the dual build is otherwise unexercised: bin/cli.js reaches it whenever a
// consumer's tooling requires rather than imports, and nothing else here loads that path.
describe('exports .cjs', () => {
  it('named exports resolve through the require condition', () => {
    for (const fn of [mapTree, peek, presetCoverage, search, initConfig, loadConfig, migrateConfig, printRows, open, clearCache, runWatch]) assert.equal(typeof fn, 'function');
    assert.equal(typeof SenseError, 'function');
    assert.equal(typeof CONFIG_FILENAME, 'string');
    assert.equal(typeof STATE_DIR, 'string');
    assert.equal(typeof SUPPORTED_CONFIG_VERSION, 'number');
    assert.equal(typeof SIGNAL_NAMES, 'object');
  });
});
