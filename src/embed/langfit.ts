import Module from 'node:module';
import { SenseError } from '../errors.ts';
import type { Store } from '../store/types.ts';
import { languageDistribution, saveLanguageDistribution } from './distribution.ts';
import { toIso3 } from './languages.ts';
import type { EmbedProvider } from './types.ts';

// franc's own reliability floor is a handful of characters; this is a cheap upper bound, not a
// per-chunk minimum -- a short chunk is simply more likely to come back 'und' (unclassified).
const SAMPLE_CHARS = 300;
// A majority computed over a handful of chunks is noise, not a corpus signal; the decision rule
// never fires below this many classified chunks, declared languages or not.
const MIN_CLASSIFIED = 10;

// franc-min is a 148K static import; a top-level import would put it on every command's module
// graph regardless of whether the semantic path ran, so it's deferred to a synchronous require.
const _require = typeof require === 'undefined' ? Module.createRequire(import.meta.url) : require;

function classify(franc: typeof import('franc-min')['franc'], text: string): string | undefined {
  const code = franc(text.slice(0, SAMPLE_CHARS));
  return code === 'und' ? undefined : code;
}

// Merges chunk texts into the persisted distribution; throws (without persisting) if the model
// declares languages and a clear majority classified so far is not among them.
export async function checkLanguageFit(store: Store, provider: EmbedProvider, texts: string[]): Promise<void> {
  if (texts.length === 0) return;
  const { franc } = _require('franc-min') as typeof import('franc-min');
  const persisted = (await languageDistribution(store)) ?? {};
  const merged = { ...persisted };
  for (const text of texts) {
    const code = classify(franc, text);
    if (code) merged[code] = (merged[code] ?? 0) + 1;
  }

  const total = Object.values(merged).reduce((a, b) => a + b, 0);
  if (provider.languages && provider.languages.length > 0 && total >= MIN_CLASSIFIED) {
    const declared = new Set(provider.languages.map(toIso3));
    const [majorityLang, majorityCount] = Object.entries(merged).sort((a, b) => b[1] - a[1])[0];
    if (majorityCount / total >= 0.5 && !declared.has(majorityLang)) {
      const pct = Math.round((majorityCount / total) * 100);
      throw new SenseError(
        'EMBED_MODEL_MISMATCH',
        `embed model ${provider.id} declares languages [${provider.languages.join(', ')}], but ${pct}% of this tree's classified text is "${majorityLang}" (ISO 639-3), which is not among them; choose a model for this tree's languages: \`sense init --model ...\`, see the sense-setup skill or INTEGRATIONS.md`
      );
    }
  }
  await saveLanguageDistribution(store, merged);
}
