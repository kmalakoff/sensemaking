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
    const EXPECTED_DIGEST = '7f1818cafe02162c5c1e77c6531d30763979b5f39c356ecd2169c36a164c1d55';
    assert.strictEqual(digest, EXPECTED_DIGEST, 'expected.json fixtures changed without updating this recorded digest');
  });
});
