import { identityHash } from './workload-identity.mjs';

const ONE_MIB = 1024 * 1024;
const DENSE_PREFIX = '---\ntitle: Delta\n---\n# Delta\n\n';
const DENSE_SUFFIX = '\n\nA walrus anchors the dense document.\n';
const DENSE_BODY_BYTES = ONE_MIB - Buffer.byteLength(DENSE_PREFIX) - Buffer.byteLength(DENSE_SUFFIX);
const DENSE_TEXT = `${DENSE_PREFIX}${'oak '.repeat(Math.floor(DENSE_BODY_BYTES / 4))}${' '.repeat(DENSE_BODY_BYTES % 4)}${DENSE_SUFFIX}`;

// Delta has more than 250,000 short words in exactly 1 MiB. Its bytes and candidates participate
// in workload identity, so a smaller or single-word surrogate cannot inherit this measurement.
export const FIXED_HYDRATION_FILES = {
  'a.md': '---\ntitle: Alpha\n---\n# Alpha\n\nThe walrus suns itself on the beach.\n',
  'b.md': `---\ntitle: Bravo\n---\n# Bravo\n\n${'ocean '.repeat(24)}A walrus dives for clams nearby.\n`,
  'c.md': `---\ntitle: Charlie\n---\n# Charlie\n\nA walrus rests on the first shore.\n\n## Present habitat\n\n${'context '.repeat(40)}A walrus returns beside the reef.\n`,
  'd.md': DENSE_TEXT,
};

// The order is intentionally unrelated to path or ranking. The caller supplies ranked candidates;
// hydration must preserve them without asking a store to rank the fixture again.
export const FIXED_HYDRATION_CANDIDATES = ['d.md', 'c.md', 'a.md', 'b.md'];
export const FIXED_HYDRATION_TERMS = ['walrus'];
export const FIXED_HYDRATION_CASES = [
  { id: 'default', char_limit: 80, count_limit: 1 },
  { id: 'larger-multi', char_limit: 160, count_limit: 2 },
];

export const FIXED_HYDRATION_SECTIONS = {
  'a.md': 'L4-7',
  'b.md': 'L4-7',
  'c.md': ['L4-7', 'L8-11'],
  'd.md': 'L4-9',
};
export const FIXED_HYDRATION_LINES = { 'a.md': 6, 'b.md': 6, 'c.md': 6, 'd.md': 8 };

// Literal expectations come from the authored words and section lines above. They do not use a
// store's output as the oracle. The focused regression checks every literal before timings qualify.
export const FIXED_HYDRATION_EXPECTED = {
  default: {
    'a.md': { snippets: ['…«walrus» suns itself on the beach. '], lines: 'L4-7' },
    'b.md': { snippets: ['…«walrus» dives for clams nearby. '], lines: 'L4-7' },
    'c.md': { snippets: ['…«walrus» rests on the first shore. ## Present habitat context context context …'], lines: 'L4-7' },
    'd.md': { snippets: ['…«walrus» anchors the dense document. '], lines: 'L4-9' },
  },
  'larger-multi': {
    'a.md': { snippets: ['…«walrus» suns itself on the beach. '], lines: 'L4-7' },
    'b.md': { snippets: ['…«walrus» dives for clams nearby. '], lines: 'L4-7' },
    'c.md': {
      snippets: ['…«walrus» rests on the first shore. ## Present habitat context context context context context context context context context context context context context …', '…«walrus» returns beside the reef. '],
      lines: 'L4-7',
    },
    'd.md': { snippets: ['…«walrus» anchors the dense document. '], lines: 'L4-9' },
  },
};

export const FIXED_HYDRATION_INPUTS = {
  operation: 'shared snippet computation and production fixed-candidate hydration',
  files: Object.fromEntries(Object.entries(FIXED_HYDRATION_FILES).map(([path, text]) => [path, { utf8_bytes: Buffer.byteLength(text), sha256: identityHash(text) }])),
  candidate_order: FIXED_HYDRATION_CANDIDATES,
  terms: FIXED_HYDRATION_TERMS,
  cases: FIXED_HYDRATION_CASES,
};

if (Buffer.byteLength(DENSE_TEXT) !== ONE_MIB) throw new Error('fixed hydration dense note must be exactly 1 MiB');
