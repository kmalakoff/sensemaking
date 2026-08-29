import { getMeta, setMeta } from '../store/meta.ts';
import type { Store } from '../store/types.ts';

// Split out of langfit.ts so reading the persisted counts (status.ts's only need) never pulls in
// franc-min; only checkLanguageFit's classify path needs the classifier itself.
const META_KEY = 'embed_languages';

export type LangCounts = Record<string, number>;

export async function languageDistribution(store: Store): Promise<LangCounts | undefined> {
  const raw = await getMeta(store, META_KEY);
  return raw ? JSON.parse(raw) : undefined;
}

export async function saveLanguageDistribution(store: Store, counts: LangCounts): Promise<void> {
  await setMeta(store, META_KEY, JSON.stringify(counts));
}
