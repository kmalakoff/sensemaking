import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'assert';
import type { ResolvedConfig } from '../../src/config/index.ts';
import { SenseError } from '../../src/errors.ts';
import { clearCache } from '../../src/store/index.ts';
import { readWatchClaim, WATCH_CLAIM_FILENAME, WatchClaimDatabase } from '../../src/watch-claim.ts';
import { scratchDir } from '../lib/scratch.ts';

describe('watch claim', () => {
  it('atomically replaces ownership and guards renew and release by token', async () => {
    const configDir = scratchDir('watch-claim-token');
    const first = new WatchClaimDatabase(configDir);
    const second = new WatchClaimDatabase(configDir);
    try {
      await first.acquire('token-a', 101, false);
      await assert.rejects(second.acquire('token-b', 202, false), (err: unknown) => {
        assert.ok(err instanceof SenseError);
        assert.equal(err.code, 'WATCH_ACTIVE');
        return true;
      });

      await second.acquire('token-b', 202, true);
      assert.equal(first.renew('token-a'), false);
      assert.equal(first.release('token-a'), false);
      assert.equal(second.read()?.token, 'token-b');
      assert.equal(second.renew('token-b'), true);
      assert.equal(second.release('token-b'), true);
      assert.equal(second.read(), null);
    } finally {
      first.close();
      second.close();
    }
  });

  it('reads absent status without creating coordinator state', () => {
    const configDir = scratchDir('watch-claim-read');
    assert.equal(readWatchClaim(configDir), null);
    assert.equal(existsSync(join(configDir, WATCH_CLAIM_FILENAME)), false);
  });

  it('survives deletion of the selected search-store cache', async () => {
    const configDir = scratchDir('watch-claim-clear-cache');
    const stateDir = join(configDir, '.sense');
    mkdirSync(stateDir);
    writeFileSync(join(stateDir, 'cache.db'), 'cache');
    const claim = new WatchClaimDatabase(configDir);
    try {
      await claim.acquire('token-a', 101, false);
      clearCache({ baseDir: configDir, configDir, rootDir: configDir, configPath: null, presets: {}, queries: {} } as ResolvedConfig);
      assert.equal(existsSync(stateDir), false);
      assert.equal(readWatchClaim(configDir)?.token, 'token-a');
    } finally {
      claim.release('token-a');
      claim.close();
    }
  });
});
