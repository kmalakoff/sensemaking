import assert from 'node:assert';
import { type SenseError, search } from 'sensemaking';
import { cohereProvider } from '../../src/embed/cohere.ts';
import { openaiProvider } from '../../src/embed/openai.ts';
import type { EmbedProvider } from '../../src/embed/types.ts';
import { CHINESE_SENTENCES, openConfig, tmpTree, writeNote } from '../lib/tree.ts';

// Gated on a variable in .env.test (gitignored) per INTEGRATIONS.md row; an unconfigured machine
// or CI skips this file. The embed/*.test.ts twins pin mock-server shape; these pin the real thing.
try {
  process.loadEnvFile('.env.test');
} catch {}

// Doc and query embeddings of related text point the same general direction; exact values are
// the model's business, direction is the contract worth pinning.
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// A full batch at the provider's own cap, which is what a first embed of a real vault sends
// and what every live test before this one avoided: whether a server accepts an array that
// size, returns one vector per input, and returns them in input order are all per-vendor
// facts, and a wrong order or a dropped input silently attaches vectors to the wrong chunks.
async function assertFullBatch(provider: EmbedProvider): Promise<void> {
  const marker = LANGUAGE_CASES.en.target;
  const alone = (await provider.embedDocuments([marker]))[0];
  const texts = Array.from({ length: provider.batchCap }, (_, i) => `Filler note number ${i} about nothing in particular.`);
  const first = 0;
  const last = provider.batchCap - 1;
  texts[first] = marker;
  texts[last] = marker;
  const vectors = await provider.embedDocuments(texts);
  assert.equal(vectors.length, provider.batchCap, 'one vector per input');
  assert.ok(vectors.every((v) => v.length === provider.dims && v.every(Number.isFinite)));
  // The marker sits at both ends, so a reversed or rotated response still lands it somewhere
  // it belongs; a filler landing there does not.
  assert.ok(cosine(vectors[first], alone) > 0.99, 'the batch position holding the marker text must carry the marker vector');
  assert.ok(cosine(vectors[last], alone) > 0.99, 'the last batch position must carry the marker vector too');
  assert.ok(cosine(vectors[1], alone) < 0.99, 'a filler position must not carry it');
}

// Skipped: the Cohere account is out of credits, so the live calls return HTTP 429.
describe.skip('cohere live', () => {
  before(function () {
    if (!process.env.SENSE_TEST_COHERE_KEY) this.skip();
  });

  it('embeds documents and a query against the real API', async function () {
    this.timeout(30_000);
    const provider = await cohereProvider('embed-v4.0', undefined, 'SENSE_TEST_COHERE_KEY');
    assert.ok(provider.dims > 0);
    const [doc] = await provider.embedDocuments(['A short note about apple varieties.']);
    const q = await provider.embedQuery('kinds of apples');
    assert.equal(doc.length, provider.dims);
    assert.equal(q.length, provider.dims);
    assert.ok(doc.every(Number.isFinite) && q.every(Number.isFinite));
    assert.ok(cosine(doc, q) > 0.3, 'related doc/query should not be orthogonal');
  });

  it('sends a full batch at the provider cap and gets them back in order', async function () {
    this.timeout(60_000);
    await assertFullBatch(await cohereProvider('embed-v4.0', undefined, 'SENSE_TEST_COHERE_KEY'));
  });
});

// Same sense per language: one note about photosynthesis, one about a capital city, and a
// query that paraphrases the first without repeating it. Which note it reaches is the model's
// answer, not the tokenizer's, so the assertion holds for any model that declares the language.
interface LanguageCase {
  target: string;
  far: string;
  query: string;
}

const LANGUAGE_CASES: Record<string, LanguageCase> = {
  en: {
    target: 'Photosynthesis lets a plant turn sunlight, water and carbon dioxide into food.',
    far: "The Tang dynasty ruled from Chang'an, one of the largest cities of its time.",
    query: 'how a plant converts solar energy into nourishment',
  },
  zh: {
    target: '光合作用是植物利用阳光、水和二氧化碳制造养分的过程。',
    far: '唐朝的首都是长安,是当时世界上最大的城市之一。',
    query: '植物如何把太阳能转化为食物',
  },
  ja: {
    target: '光合成は植物が太陽の光と水と二酸化炭素から栄養を作る仕組みです。',
    far: '奈良時代の都は平城京で、当時の日本の中心でした。',
    query: '植物はどうやって太陽の光を養分に変えるのか',
  },
  ru: {
    target: 'Фотосинтез позволяет растению превращать солнечный свет, воду и углекислый газ в питание.',
    far: 'Столицей Российской империи долгое время был Санкт-Петербург.',
    query: 'как растение превращает солнечную энергию в пищу',
  },
  de: {
    target: 'Bei der Photosynthese stellt eine Pflanze aus Sonnenlicht, Wasser und Kohlendioxid Nahrung her.',
    far: 'Die Hauptstadt des Deutschen Reiches war lange Zeit Berlin.',
    query: 'wie eine Pflanze Sonnenenergie in Nahrung umwandelt',
  },
};

// Ollama and LM Studio are the same `openai` provider at different endpoints, so they are the
// same suite twice. <VENDOR>_URL gates it; _MODEL names the tag; _LANGUAGES is the model's
// declared language list, passed straight through as the config's embed.languages, so a
// machine tests exactly what its model supports and nothing it does not. The defaults are the
// pair INTEGRATIONS.md measured; any other model names both.
function httpSuite(vendor: string, defaults?: { model: string; languages: string }): void {
  const url = process.env[`SENSE_TEST_${vendor}_URL`];
  const model = process.env[`SENSE_TEST_${vendor}_MODEL`] ?? defaults?.model;
  const keyEnv = process.env[`SENSE_TEST_${vendor}_KEY`] ? `SENSE_TEST_${vendor}_KEY` : undefined;
  const languages = (process.env[`SENSE_TEST_${vendor}_LANGUAGES`] ?? defaults?.languages ?? 'en').split(',').map((l) => l.trim());

  describe(`${vendor.toLowerCase()} live`, () => {
    before(function () {
      if (!url) this.skip();
      // Gated in but incomplete: a mode, not a skip, and misconfiguration is an error.
      if (!model) throw new Error(`SENSE_TEST_${vendor}_URL is set but SENSE_TEST_${vendor}_MODEL names no model`);
    });

    function open(baseDir: string, declared: string[]) {
      return openConfig({ presets: { default: { include: ['**/*.md'], signals: { vectors: 1 } } }, embed: { model: model as string, provider: 'openai', url, key: keyEnv, languages: declared }, queries: {}, baseDir, configPath: null });
    }

    it('embeds a batch and a query against the real endpoint', async function () {
      this.timeout(120_000);
      const provider = await openaiProvider(model as string, url, keyEnv);
      assert.ok(provider.dims > 0);
      const { target, far, query } = LANGUAGE_CASES.en;
      const docs = await provider.embedDocuments([target, far]);
      const q = await provider.embedQuery(query);
      assert.equal(docs.length, 2);
      assert.ok(docs.every((d) => d.length === provider.dims && d.every(Number.isFinite)));
      assert.equal(q.length, provider.dims);
      assert.ok(cosine(docs[0], q) > cosine(docs[1], q), 'the paraphrased note should sit closer to the query than the unrelated one');
    });

    it('sends a full batch at the provider cap and gets them back in order', async function () {
      this.timeout(120_000);
      await assertFullBatch(await openaiProvider(model as string, url, keyEnv));
    });

    for (const language of languages) {
      const testCase = LANGUAGE_CASES[language];
      if (!testCase) continue; // a declared language this suite has no fixture for
      it(`${language}: a tree the model declares embeds and answers by meaning`, async function () {
        this.timeout(120_000);
        const baseDir = tmpTree();
        writeNote(baseDir, 'target.md', { body: testCase.target });
        writeNote(baseDir, 'far.md', { body: testCase.far });
        const { store: db, cfg } = await open(baseDir, languages);
        const rows = (await search(db, cfg, testCase.query)) as Array<{ path: string; via: string }>;
        await db.close();
        assert.equal(rows[0]?.path, 'target.md', JSON.stringify(rows));
        assert.equal(rows[0].via, 'vector');
      });
    }

    // Model-independent: the fit check reads the declared list, so declaring only English over
    // a Chinese tree must stop the run whatever the endpoint's model can actually do.
    it('a Chinese tree under embed.languages ["en"] fails with EMBED_MODEL_MISMATCH', async function () {
      this.timeout(120_000);
      const baseDir = tmpTree();
      writeNote(baseDir, 'zh.md', { body: CHINESE_SENTENCES.map((line, i) => `## S${i}\n\n${line}`).join('\n\n') });
      const { store: db, cfg } = await open(baseDir, ['en']);
      await assert.rejects(
        () => search(db, cfg, LANGUAGE_CASES.zh.query),
        (err: SenseError) => {
          assert.equal(err.code, 'EMBED_MODEL_MISMATCH');
          assert.match(err.message, /"cmn"/);
          return true;
        }
      );
      await db.close();
    });
  });
}

httpSuite('OLLAMA', { model: 'qwen3-embedding:0.6b', languages: 'en,zh,ja,ru,de' });
httpSuite('LMSTUDIO');
