// HF model cards declare languages as ISO 639-1 tags (e.g. "zh"); franc-min reports ISO 639-3
// (e.g. "cmn"). This bridges the two for comparison. Limited to franc-min's own 82-language
// data (README table, https://github.com/wooorm/franc), so every value here is a code franc-min
// can actually emit; a declared tag with no entry here is compared as-is.
const ISO_639_1_TO_3: Record<string, string> = {
  ar: 'arb',
  am: 'amh',
  az: 'azj',
  be: 'bel',
  bg: 'bul',
  bn: 'ben',
  bs: 'bos',
  cs: 'ces',
  de: 'deu',
  el: 'ell',
  en: 'eng',
  es: 'spa',
  fa: 'pes',
  fr: 'fra',
  gu: 'guj',
  ha: 'hau',
  hi: 'hin',
  hr: 'hrv',
  hu: 'hun',
  id: 'ind',
  ig: 'ibo',
  it: 'ita',
  ja: 'jpn',
  jv: 'jav',
  kk: 'kaz',
  kn: 'kan',
  ko: 'kor',
  ml: 'mal',
  mr: 'mar',
  ms: 'zlm',
  my: 'mya',
  ne: 'npi',
  nl: 'nld',
  pa: 'pan',
  pl: 'pol',
  pt: 'por',
  ro: 'ron',
  ru: 'rus',
  rw: 'kin',
  si: 'sin',
  so: 'som',
  sr: 'srp',
  su: 'sun',
  sv: 'swe',
  sw: 'swh',
  ta: 'tam',
  te: 'tel',
  th: 'tha',
  tl: 'tgl',
  tr: 'tur',
  uk: 'ukr',
  ur: 'urd',
  uz: 'uzn',
  vi: 'vie',
  yo: 'yor',
  zh: 'cmn',
  zu: 'zul',
};

export function isKnownLanguageTag(tag: string): boolean {
  return tag in ISO_639_1_TO_3;
}

// Normalizes a declared or detected language code to ISO 639-3 for comparison; strips a
// region/script subtag ("zh-cn" -> "zh") first. Codes already in 639-3 form pass through.
export function toIso3(code: string): string {
  const base = code.toLowerCase().split('-')[0];
  return ISO_639_1_TO_3[base] ?? base;
}

// Languages this project measured for models whose cards declare none, so the fit check is
// not silently off for the shipped default; asserted here because it was measured, not attested.
export const MEASURED_MODEL_LANGUAGES: Record<string, string[]> = {
  'minishlab/potion-retrieval-32M': ['en'], // benchmark/reports/2026-08-27-embedding-model-selection.md
};
