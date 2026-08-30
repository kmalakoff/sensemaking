import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tokenizer } from '@huggingface/tokenizers';
import { staticProvider } from '../../../src/embed/static.ts';
import { downloadModelRevision, MODEL_FILES, snapshotDir } from '../../../src/embed/store.ts';
import type { EmbedProvider } from '../../../src/embed/types.ts';
import { gate } from '../../lib/gate.ts';

// Oracle diff: fixtures are Python model2vec + tokenizers output, run once offline and
// committed (test/fixtures/parity/generate.py); this suite reproduces them via JS with no Python in CI.
const MODEL_ID = 'minishlab/potion-retrieval-32M';
const REVISION = '6fc8051fab2a1e0ee76689cf08c853792ac285e7';

interface FixtureCase {
  category: string;
  input: string;
  token_ids: number[];
  vector: number[];
}

interface Fixtures {
  meta: { model: string; revision: string };
  cases: FixtureCase[];
}

const fixturesPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'parity', 'fixtures.json');
const fixtures: Fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8'));
assert.equal(fixtures.meta.model, MODEL_ID, 'fixtures.json was generated for a different model than this suite is pinned to');
assert.equal(fixtures.meta.revision, REVISION, 'fixtures.json was generated for a different revision than this suite is pinned to');

function hasFilesAt(dir: string): boolean {
  return MODEL_FILES.every((file) => existsSync(join(dir, file)));
}

function cosine(a: Float32Array, b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < b.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Tolerance: element-wise <= 1e-5, cosine >= 0.999999 for non-zero vectors; a near-zero
// fixture vector (empty/whitespace/oov input) must come back exactly zero, since cosine is undefined there.
function assertVectorParity(category: string, expected: number[], actual: Float32Array): void {
  assert.equal(actual.length, expected.length, `${category}: dims mismatch, fixture ${expected.length} vs js ${actual.length}`);

  const expectedNormSq = expected.reduce((sum, v) => sum + v * v, 0);
  if (expectedNormSq < 1e-12) {
    for (let i = 0; i < actual.length; i++) {
      if (actual[i] !== 0) assert.fail(`${category}: expected an all-zero vector, index ${i} is ${actual[i]}`);
    }
    return;
  }

  for (let i = 0; i < expected.length; i++) {
    const diff = Math.abs(actual[i] - expected[i]);
    if (diff > 1e-5) assert.fail(`${category}: element ${i} differs beyond tolerance (1e-5): fixture=${expected[i]}, js=${actual[i]}`);
  }
  const sim = cosine(actual, expected);
  assert.ok(sim >= 0.999999, `${category}: cosine similarity ${sim} below 0.999999`);
}

describe('embedding parity against the Python reference', () => {
  let provider: EmbedProvider;
  let tokenizer: InstanceType<typeof Tokenizer>;

  before(async function () {
    // A cold machine downloads ~129 MB into the real store here (once); every later run of
    // this suite, on this machine, finds it cached and skips straight to the comparison.
    this.timeout(180_000);

    const modelPath = snapshotDir(MODEL_ID, REVISION);
    if (!hasFilesAt(modelPath)) {
      try {
        // The pinned revision, never `main`: a mutable HF ref must never compare against
        // different weights than the fixtures were generated from. Cached under ~/.sense/models.
        await downloadModelRevision(MODEL_ID, REVISION, (file, into) => console.error(`fetching ${MODEL_ID}@${REVISION.slice(0, 8)}/${file} into ${into}`));
      } catch (err) {
        // Neither the machine cache nor the network has the model: nothing to diff against.
        // ci and local-release own this gate and fail rather than skip past it.
        gate(this, 'hf-network', false, (err as Error).message);
        return;
      }
    }

    provider = await staticProvider(modelPath);

    // Loaded independently of staticProvider, exactly as src/embed/static.ts does, so this
    // exercises the raw tokenizer output (pre unk-filter) rather than the provider's filtered ids.
    const tokenizerJson = JSON.parse(readFileSync(join(modelPath, 'tokenizer.json'), 'utf8'));
    tokenizer = new Tokenizer(tokenizerJson, {});
  });

  it('provider dims match the fixture model', () => {
    assert.equal(provider.dims, 512);
  });

  describe('tokenizer parity: raw ids, before unk-filtering', () => {
    for (const c of fixtures.cases) {
      it(c.category, () => {
        const ids = tokenizer.encode(c.input, { add_special_tokens: false }).ids as number[];
        assert.deepEqual(ids, c.token_ids, `${c.category}: token ids diverge from the Python tokenizers reference`);
      });
    }
  });

  describe('vector parity: embedQuery', () => {
    for (const c of fixtures.cases) {
      it(c.category, async () => {
        const v = await provider.embedQuery(c.input);
        assertVectorParity(c.category, c.vector, v);
      });
    }
  });

  describe('vector parity: embedDocuments', () => {
    for (const c of fixtures.cases) {
      it(c.category, async () => {
        const [v] = await provider.embedDocuments([c.input]);
        assertVectorParity(c.category, c.vector, v);
      });
    }
  });
});
