// The synthetic corpus generator: a seeded builder whose output is a function of the spec and this
// source. GENERATOR_REVISION is part of every synthetic cache key; bump it whenever the output
// can change (test/integration/benchmark-cache.test.ts fails until the recorded source hash follows).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { contentKey } from './cache.ts';
import { mulberry32 } from './prng.ts';
import { writeTreeConfig } from './tree-config.ts';

export const GENERATOR_REVISION = 2;
// Files whose source decides a synthetic tree's bytes.
export const GENERATOR_SOURCES = ['benchmark/lib/synthetic.ts', 'benchmark/lib/prng.ts', 'benchmark/lib/tree-config.ts'];

type Random = () => number;
export interface SyntheticOptions {
  notes?: number;
  noteTokens?: number;
  headingsPerNote?: number;
  linksPerNote?: number;
  distinctFields?: number;
  fieldsPerNote?: number;
  seed?: number;
  dirDepth?: number;
  bigNoteBytes?: number;
  adversarial?: boolean;
  embed?: boolean;
  presets?: { name: string; dir: string; semantic?: boolean }[] | null;
}

// Fixed vocabulary sampled zipf-skewed (rank i weight 1/(i+1)^1.07) so a handful of words
// dominate like real prose -- uniform noise would make BM25 ranking degenerate.
const VOCAB = (
  'the of and to in a is that for on with as it be by this at from or an are was were been ' +
  'have has had will would could should may might must can note idea system data value time ' +
  'work process design build test plan review change update note link section field query ' +
  'tree file path graph rank score index search result output input state model type name key ' +
  'group list item level order count total range limit scope goal task step phase draft final ' +
  'source target owner status open close active done next prior recent old new small large deep ' +
  'flat wide narrow fast slow cheap costly clear vague broad tight loose firm soft hard easy'
).split(/\s+/);

function zipfPicker(rand: Random) {
  const n = VOCAB.length;
  const weights = new Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    weights[i] = 1 / (i + 1) ** 1.07;
    total += weights[i];
  }
  const cum = new Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += weights[i] / total;
    cum[i] = acc;
  }
  return () => {
    const x = rand();
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return VOCAB[lo];
  };
}

// k distinct indices in [0,n), never excludeIdx. Dense k shuffles; sparse k (e.g. 5 links out
// of 100k notes) retries a Set instead -- a full shuffle would be O(n) per note.
function chooseKIndices(rand: Random, n: number, k: number, excludeIdx: number) {
  const avail = excludeIdx >= 0 && excludeIdx < n ? n - 1 : n;
  k = Math.max(0, Math.min(k, avail));
  if (k === 0) return [];
  if (k > avail * 0.5) {
    const arr = [];
    for (let i = 0; i < n; i++) if (i !== excludeIdx) arr.push(i);
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.slice(0, k);
  }
  const chosen = new Set<number>();
  while (chosen.size < k) {
    const idx = Math.floor(rand() * n);
    if (idx !== excludeIdx) chosen.add(idx);
  }
  return [...chosen];
}

function fieldValue(rand: Random, pickWord: () => string, type: string) {
  switch (type) {
    case 'int':
      return Math.floor(rand() * 10000);
    case 'date': {
      const day = Math.floor(rand() * 3650);
      return new Date(Date.UTC(2016, 0, 1) + day * 86400000).toISOString().slice(0, 10);
    }
    case 'array':
      return Array.from({ length: 2 + Math.floor(rand() * 3) }, () => pickWord());
    default:
      return `${pickWord()} ${pickWord()}`;
  }
}

// Quote scalars so the yaml parser reads them as TEXT (an unquoted ISO date resolves to a
// YAML timestamp, not a string) -- same convention as the beir/fever builders' JSON.stringify title.
function yamlValue(v: string | number | string[]) {
  if (Array.isArray(v)) return `[${v.map((s) => JSON.stringify(s)).join(', ')}]`;
  if (typeof v === 'number') return String(v);
  return JSON.stringify(v);
}

// Pathological markdown for the remove-markdown crawl-timeout probe: deeply nested emphasis
// (backtracking-class regex risk), long bracket runs, thousands of unclosed links, one huge line.
function adversarialBody(pickWord: () => string) {
  const nestedEmphasis = `***${'*'.repeat(200)}${pickWord()}${'*'.repeat(200)}***`;
  const bracketRun = '['.repeat(5000);
  const unclosedLinks = Array.from({ length: 3000 }, () => `[${pickWord()}(`).join('');
  const longLine = Array.from({ length: 20000 }, () => pickWord()).join(' ');
  return [nestedEmphasis, bracketRun, unclosedLinks, longLine].join('\n\n');
}

function buildBody(rand: Random, pickWord: () => string, headingsN: number, noteTokens: number, wikiTargets: readonly string[]) {
  const targetChars = noteTokens * 4;
  const wordsPerSection = Math.max(3, Math.round(targetChars / Math.max(headingsN, 1) / 6));
  const lines = [];
  for (let h = 0; h < headingsN; h++) {
    lines.push(`## ${pickWord()} ${pickWord()}`, '');
    const sectionLines = 1 + Math.floor(rand() * 2);
    for (let li = 0; li < sectionLines; li++) lines.push(`${Array.from({ length: wordsPerSection }, () => pickWord()).join(' ')}.`);
    lines.push('');
  }
  if (wikiTargets.length) lines.push(wikiTargets.map((t) => `[[${t}]]`).join(' '));
  return lines.join('\n');
}

export const SYNTHETIC_DEFAULTS = {
  notes: 500,
  noteTokens: 500,
  headingsPerNote: 8,
  linksPerNote: 5,
  distinctFields: 30,
  fieldsPerNote: 8,
  seed: 1,
  dirDepth: 3,
  bigNoteBytes: 0, // filesize dimension: pad note 0's body to ~this many bytes
  adversarial: false, // remove-markdown probe: pathological bodies instead of prose
  embed: false, // semantic dimension: write features.embed into sense.config.json
  presets: null as SyntheticOptions['presets'], // presets dimension: [{name, dir, semantic}] -> write a v3 presets config instead, one folder per preset
};

// Cache key from every param value and the generator revision, not a catalog name or label. The
// prefix keeps .cache/shared readable; the hash is what names the content.
export function syntheticSpecKey(spec: SyntheticOptions, generatorRevision = GENERATOR_REVISION) {
  const full = { ...SYNTHETIC_DEFAULTS, ...spec };
  return contentKey(`synthetic-n${full.notes}-t${full.noteTokens}-h${full.headingsPerNote}-l${full.linksPerNote}-f${full.distinctFields}-fpn${full.fieldsPerNote}-s${full.seed}`, { ...full, generatorRevision });
}

// Synthetic tree for shape sweeps (benchmark/tools/sweep.ts): each dimension holds the other params
// at hub-like values and varies one. Everything derives from spec.seed, so a spec is reproducible.
export function buildSynthetic(spec: SyntheticOptions, dest: string) {
  const cfg = { ...SYNTHETIC_DEFAULTS, ...spec };
  const rand = mulberry32(cfg.seed);
  const pickWord = zipfPicker(rand);

  // A few subdirectories at varying depth, spread across levels rather than balanced. Presets
  // mode instead uses one fixed, named folder per preset, so each preset's include glob is exact.
  const dirs = cfg.presets
    ? cfg.presets.map((p) => p.dir)
    : Array.from({ length: Math.max(1, Math.min(40, Math.ceil(cfg.notes / 50))) }, () => {
        const depth = 1 + Math.floor(rand() * cfg.dirDepth);
        return Array.from({ length: depth }, () => `d${Math.floor(rand() * 20)}`).join('/');
      });

  const basenames = Array.from({ length: cfg.notes }, (_, i) => `note-${String(i).padStart(6, '0')}`);
  const fieldPool = Array.from({ length: cfg.distinctFields }, (_, i) => `field${i}`);
  const FIELD_TYPES = ['string', 'int', 'date', 'array'];

  for (let i = 0; i < cfg.notes; i++) {
    // presets mode: round-robin so every folder gets an even share; otherwise random, matching the existing shape sweeps.
    const dir = cfg.presets ? dirs[i % dirs.length] : dirs[Math.floor(rand() * dirs.length)];
    mkdirSync(join(dest, dir), { recursive: true });

    const fm: Record<string, string | number | string[]> = { title: `${pickWord()} ${pickWord()}` };
    for (const fi of chooseKIndices(rand, cfg.distinctFields, cfg.fieldsPerNote, -1)) {
      fm[fieldPool[fi]] = fieldValue(rand, pickWord, FIELD_TYPES[fi % FIELD_TYPES.length]);
    }
    const frontmatter = `---\n${Object.entries(fm)
      .map(([k, v]) => `${k}: ${yamlValue(v)}`)
      .join('\n')}\n---\n\n`;

    const linkTargets = chooseKIndices(rand, cfg.notes, cfg.linksPerNote, i).map((li) => basenames[li]);
    let body = cfg.adversarial ? adversarialBody(pickWord) : buildBody(rand, pickWord, cfg.headingsPerNote, i === 0 && cfg.bigNoteBytes ? Math.round(cfg.bigNoteBytes / 4) : cfg.noteTokens, linkTargets);
    if (i === 0 && cfg.bigNoteBytes) {
      while (body.length < cfg.bigNoteBytes) body += `\n\n${Array.from({ length: 200 }, () => pickWord()).join(' ')}.`;
    }

    writeFileSync(join(dest, dir, `${basenames[i]}.md`), `${frontmatter}${body}\n`);
  }

  if (cfg.presets) {
    const presets = Object.fromEntries(cfg.presets.map((p) => [p.name, { include: [`${p.dir}/**/*.md`], ...(p.semantic === false ? { semantic: false } : {}) }]));
    writeTreeConfig(dest, { version: 3, presets, queries: {} });
  } else {
    writeTreeConfig(dest, { version: 2, scan: { include: ['**/*.md'] }, queries: {}, ...(cfg.embed ? { features: { embed: true } } : {}) });
  }
}
