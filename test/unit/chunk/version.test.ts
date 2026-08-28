import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// D8: CHUNK_VERSION (./version.ts) must bump whenever the fixture suite's content changes --
// this digest is the trip-wire that catches a regeneration without a matching bump.

describe('chunk fixtures: signature drift guard', () => {
  it('digest of all pinned expected.json files matches the recorded constant', () => {
    const casesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'chunk', 'cases');
    const names = readdirSync(casesDir)
      .filter((name) => statSync(join(casesDir, name)).isDirectory())
      .sort();
    const hash = createHash('sha256');
    for (const name of names) hash.update(readFileSync(join(casesDir, name, 'expected.json')));
    const digest = hash.digest('hex');
    // chunk behavior changed -> regenerate fixtures, update this digest, and bump CHUNK_VERSION in src/chunk/version.ts
    const EXPECTED_DIGEST = '00caeec332ad366cbfe3a7b385eb6ea9becd70825c7b1d54f17e1f9a33191166';
    assert.strictEqual(digest, EXPECTED_DIGEST, 'expected.json fixtures changed without updating this recorded digest');
  });
});
