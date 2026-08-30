import assert from 'node:assert';
import { CONFIG_FILENAME, clearCache, initConfig, loadConfig, mapTree, migrateConfig, open, peek, presetCoverage, printRows, runWatch, SenseError, SIGNAL_NAMES, STATE_DIR, SUPPORTED_CONFIG_VERSION, search } from 'sensemaking';

describe('exports .mjs', () => {
  it('named exports resolve through the esm condition', () => {
    for (const fn of [mapTree, peek, presetCoverage, search, initConfig, loadConfig, migrateConfig, printRows, open, clearCache, runWatch]) assert.equal(typeof fn, 'function');
    assert.equal(typeof SenseError, 'function');
    assert.equal(typeof CONFIG_FILENAME, 'string');
    assert.equal(typeof STATE_DIR, 'string');
    assert.equal(typeof SUPPORTED_CONFIG_VERSION, 'number');
    assert.equal(typeof SIGNAL_NAMES, 'object');
  });
});
