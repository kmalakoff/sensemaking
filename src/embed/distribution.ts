import type { DatabaseSync } from 'node:sqlite';
import { getMeta, setMeta } from '../db/shared.ts';

// Split out of langfit.ts so reading the persisted counts (status.ts's only need) never pulls in
// franc-min; only checkLanguageFit's classify path needs the classifier itself.
const META_KEY = 'embed_languages';

export type LangCounts = Record<string, number>;

export function languageDistribution(db: DatabaseSync): LangCounts | undefined {
  const raw = getMeta(db, META_KEY);
  return raw ? JSON.parse(raw) : undefined;
}

export function saveLanguageDistribution(db: DatabaseSync, counts: LangCounts): void {
  setMeta(db, META_KEY, JSON.stringify(counts));
}
