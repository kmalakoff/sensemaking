import assert from 'node:assert';
import { languageDistribution } from '../../../src/embed/distribution.ts';
import { checkLanguageFit } from '../../../src/embed/langfit.ts';
import type { EmbedProvider } from '../../../src/embed/types.ts';
import { CHINESE_SENTENCES, openTree, tmpTree } from '../../lib/tree.ts';

// languageDistribution lives in src/embed/distribution.ts so status.ts's read of persisted
// counts never pulls in franc-min; tested here since that persisted state is checkLanguageFit's contract.

// Reliable single-language pools, verified against the real franc-min classifier (no mocking a
// parser, per house rule): CHINESE_SENTENCES all classify as 'cmn', these as 'eng'/'spa'.
const EN_SENTENCES = [
  'The quick brown fox jumps over the lazy dog near the river bank today.',
  'Software engineers write tests to make sure their code behaves correctly every day.',
  'The weather has been quite pleasant this week, perfect for a long walk outside.',
  'Please submit the signed document to the manager before the end of the day.',
  'China has a long and glorious history full of rich cultural traditions and stories.',
  'We are planning a trip to the mountains next month with the whole family.',
  'This restaurant serves the most delicious food in the entire neighborhood.',
  'Learning a new language takes patience, practice, and a lot of daily effort.',
  'The city traffic gets extremely congested during the morning rush hour commute.',
  'She enjoys reading novels and painting landscapes on quiet weekend afternoons.',
  'Technology has changed the way people communicate and work around the world.',
  'The museum exhibit featured ancient artifacts collected from several countries.',
];
const ES_SENTENCES = ['El clima ha sido muy agradable esta semana, perfecto para caminar al aire libre.', 'Por favor entregue el documento firmado al gerente antes del final del día.', 'Ella disfruta leyendo novelas y pintando paisajes los fines de semana tranquilos.'];

async function db() {
  const { store } = await openTree(tmpTree());
  return store;
}

function provider(languages?: string[]): EmbedProvider {
  return {
    id: 'static:test-model',
    dims: 8,
    batchCap: 64,
    languages,
    embedDocuments: async () => {
      throw new Error('not used by checkLanguageFit');
    },
    embedQuery: async () => {
      throw new Error('not used by checkLanguageFit');
    },
  };
}

describe('languageDistribution', () => {
  it('is undefined before anything has been classified', async () => {
    assert.equal(await languageDistribution(await db()), undefined);
  });

  it('reflects what checkLanguageFit persisted', async () => {
    const database = await db();
    await checkLanguageFit(database, provider(), CHINESE_SENTENCES.slice(0, 5));
    assert.deepEqual(await languageDistribution(database), { cmn: 5 });
  });
});

describe('checkLanguageFit', () => {
  it('no-ops on an empty text list: no persistence, no throw', async () => {
    const database = await db();
    await checkLanguageFit(database, provider(['en']), []);
    assert.equal(await languageDistribution(database), undefined);
  });

  it('merges into the persisted distribution across calls', async () => {
    const database = await db();
    await checkLanguageFit(database, provider(), CHINESE_SENTENCES.slice(0, 3));
    await checkLanguageFit(database, provider(), EN_SENTENCES.slice(0, 2));
    assert.deepEqual(await languageDistribution(database), { cmn: 3, eng: 2 });
  });

  it('never throws below the 10-classified-chunk floor, declared languages notwithstanding', async () => {
    const database = await db();
    // 5 classified chunks, all "cmn", against a model declaring only "en" -- would be a 100%
    // mismatch above the floor, but MIN_CLASSIFIED gates the check off entirely below it.
    await checkLanguageFit(database, provider(['en']), CHINESE_SENTENCES.slice(0, 5));
    assert.deepEqual(await languageDistribution(database), { cmn: 5 });
  });

  it('never throws when the majority is under 50%, even above the classified floor', async () => {
    const database = await db();
    // 10 total classified: 4 cmn (40%), 3 eng, 3 spa -- no code reaches the 50% majority rule.
    await checkLanguageFit(database, provider(['en']), [...CHINESE_SENTENCES.slice(0, 4), ...EN_SENTENCES.slice(0, 3), ...ES_SENTENCES]);
    assert.deepEqual(await languageDistribution(database), { cmn: 4, eng: 3, spa: 3 });
  });

  it('does not throw when the majority language is among the declared languages', async () => {
    const database = await db();
    await checkLanguageFit(database, provider(['zh']), CHINESE_SENTENCES); // toIso3('zh') === 'cmn'
    assert.deepEqual(await languageDistribution(database), { cmn: 12 });
  });

  it('never throws when the provider declares no languages at all', async () => {
    const database = await db();
    await checkLanguageFit(database, provider(undefined), CHINESE_SENTENCES);
    await checkLanguageFit(database, provider([]), CHINESE_SENTENCES);
    assert.deepEqual(await languageDistribution(database), { cmn: 24 });
  });

  it('throws EMBED_MODEL_MISMATCH naming the model, declared languages, majority code, and the fix, once the majority (>=50%, >=10 classified) is not declared', async () => {
    const database = await db();
    await assert.rejects(
      () => checkLanguageFit(database, provider(['en']), CHINESE_SENTENCES),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, 'EMBED_MODEL_MISMATCH');
        assert.match(err.message, /static:test-model/); // model
        assert.match(err.message, /\[en\]/); // declared languages
        assert.match(err.message, /100% .* "cmn"/); // majority code + share
        assert.match(err.message, /sense init --model/); // fix
        assert.match(err.message, /sense-setup skill|INTEGRATIONS\.md/); // fix, continued
        return true;
      }
    );
  });

  it('throws without persisting: a mismatch leaves the prior distribution untouched', async () => {
    const database = await db();
    await checkLanguageFit(database, provider(['en']), CHINESE_SENTENCES.slice(0, 5)); // below the floor, persists
    assert.deepEqual(await languageDistribution(database), { cmn: 5 });
    await assert.rejects(() => checkLanguageFit(database, provider(['en']), CHINESE_SENTENCES.slice(5, 10)), /not among them/);
    // The would-be merge (10 total, 100% cmn) crossed the floor and mismatched -- never saved.
    assert.deepEqual(await languageDistribution(database), { cmn: 5 });
  });
});
