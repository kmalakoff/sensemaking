// Corpus catalog: declarative specs, one builder per source type, resolution through the
// fetch-once cache. corpusPath(name) returns the markdown tree; corpusLabels(name) returns
// the query/qrels directory for labeled datasets, or null.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cached } from './cache.mjs';

// mulberry32: tiny deterministic PRNG so a spec reproduces byte-identical trees across runs/machines.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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

function zipfPicker(rand) {
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

// k distinct indices in [0,n), never excludeIdx. Dense case (k close to n, e.g. fieldsPerNote
// == distinctFields for the column-limit probe) shuffles; sparse case (k << n, e.g. 5 links
// out of 100k notes) retries a Set -- a full shuffle at that end would be O(n) per note.
function chooseKIndices(rand, n, k, excludeIdx) {
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
  const chosen = new Set();
  while (chosen.size < k) {
    const idx = Math.floor(rand() * n);
    if (idx !== excludeIdx) chosen.add(idx);
  }
  return [...chosen];
}

function fieldValue(rand, pickWord, type) {
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
function yamlValue(v) {
  if (Array.isArray(v)) return `[${v.map((s) => JSON.stringify(s)).join(', ')}]`;
  if (typeof v === 'number') return String(v);
  return JSON.stringify(v);
}

// Pathological markdown for the remove-markdown crawl-timeout probe: deeply nested emphasis
// (backtracking-class regex risk), long bracket runs, thousands of unclosed links, one huge line.
function adversarialBody(pickWord) {
  const nestedEmphasis = `***${'*'.repeat(200)}${pickWord()}${'*'.repeat(200)}***`;
  const bracketRun = '['.repeat(5000);
  const unclosedLinks = Array.from({ length: 3000 }, () => `[${pickWord()}(`).join('');
  const longLine = Array.from({ length: 20000 }, () => pickWord()).join(' ');
  return [nestedEmphasis, bracketRun, unclosedLinks, longLine].join('\n\n');
}

function buildBody(rand, pickWord, headingsN, noteTokens, wikiTargets) {
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

const SYNTHETIC_DEFAULTS = {
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
  presets: null, // presets dimension: [{name, dir, semantic}] -> write a v3 presets config instead, one folder per preset
};

// Recursive key sort, so nested spec objects keep a stable hash; a top-level replacer would
// strip every key of a nested object instead.
function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

// Cache key from the param values (not the catalog name -- synthetic corpora are requested
// by spec object, see syntheticPath). A short hash covers every field so an unlisted param
// still busts the cache; the descriptive prefix keeps .tmp/cache/ readable.
function specKey(spec) {
  const full = { ...SYNTHETIC_DEFAULTS, ...spec };
  const json = stableStringify(full);
  let hash = 2166136261;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const short = (hash >>> 0).toString(16).padStart(8, '0');
  return `synthetic-n${full.notes}-t${full.noteTokens}-h${full.headingsPerNote}-l${full.linksPerNote}-f${full.distinctFields}-fpn${full.fieldsPerNote}-s${full.seed}-${short}`;
}

const CORPORA = {
  // Real Obsidian-style tree: wikilinks, frontmatter, no relevance labels.
  'obsidian-hub': {
    type: 'git',
    repo: 'https://github.com/community-archive/obsidian-hub',
    commit: 'b11036f9a4db77917a4f07804541cceffc96cc66',
  },
  // BEIR NFCorpus: 3,633 prose docs, 323 test queries, dense qrels (~38 judged/query).
  // No links -- measures BM25 recall, not link fusion.
  nfcorpus: {
    type: 'beir',
    url: 'https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/nfcorpus.zip',
    version: 'beir-1',
  },
  // FEVER: claims labeled with their Wikipedia evidence pages, sentence links kept as
  // wikilinks -- the only corpus that can measure link fusion. Scale rows replicate one real
  // corpus N times, so duplicate basenames also stress link-ambiguity resolution.
  'obsidian-hub-x2': { type: 'replicate', source: 'obsidian-hub', copies: 2, version: 'x2-hub-1' },
  'obsidian-hub-x4': { type: 'replicate', source: 'obsidian-hub', copies: 4, version: 'x4-hub-1' },
  // Every fixed shape cliff in one tree: 1MB note, 200 headings/note, 100 links/note, 300
  // fields. The release gate runs it so a cliff regression moves a row instead of shipping.
  stress: { type: 'synthetic', notes: 2000, noteTokens: 500, headingsPerNote: 200, linksPerNote: 100, distinctFields: 300, fieldsPerNote: 8, seed: 42, bigNoteBytes: 1_000_000, version: 'stress-1' },
  fever: {
    type: 'fever',
    wikiUrl: 'https://fever.ai/download/fever/wiki-pages.zip',
    devUrl: 'https://fever.ai/download/fever/shared_task_dev.jsonl',
    version: 'fever-1',
  },
};

export const CORPUS_NAMES = Object.keys(CORPORA);

const BUILDERS = {
  git(spec, dest) {
    execFileSync('git', ['clone', '--quiet', spec.repo, dest], { stdio: ['ignore', 'ignore', 'inherit'] });
    execFileSync('git', ['-C', dest, 'checkout', '--quiet', spec.commit]);
  },
  // BEIR zips carry corpus.jsonl + queries.jsonl + qrels/*.tsv. Docs become one md file
  // each (id as filename, title in frontmatter, text as body) so the corpus is a sense
  // tree; queries and qrels land in labels/ for the eval harness.
  beir(spec, dest) {
    const zip = join(dest, 'dataset.zip');
    execFileSync('curl', ['-fsSL', '-o', zip, spec.url]);
    execFileSync('unzip', ['-q', zip, '-d', dest]);
    execFileSync('rm', [zip]);
    const inner = join(dest, 'nfcorpus');
    const tree = join(dest, 'tree');
    const labels = join(dest, 'labels');
    mkdirSync(tree, { recursive: true });
    mkdirSync(labels, { recursive: true });
    for (const line of readFileSync(join(inner, 'corpus.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const doc = JSON.parse(line);
      const title = JSON.stringify(doc.title ?? '');
      writeFileSync(join(tree, `${doc._id}.md`), `---\ntitle: ${title}\n---\n\n${doc.text}\n`);
    }
    writeFileSync(join(tree, 'sense.config.json'), '{"version":1,"scan":{"include":["**/*.md"]},"queries":{}}');
    execFileSync('cp', [join(inner, 'queries.jsonl'), labels]);
    execFileSync('bash', ['-c', `cp ${JSON.stringify(join(inner, 'qrels'))}/*.tsv ${JSON.stringify(labels)}`]);
  },
  // Pages arrive as jsonl shards in a 1.7GB zip; `lines` annotates sentences with (anchor,
  // target) pairs. Targets are display titles, so they normalize to id form to match filenames.
  fever(spec, dest) {
    const toId = (t) => t.replace(/ /g, '_').replace(/\(/g, '-LRB-').replace(/\)/g, '-RRB-').replace(/:/g, '-COLON-');
    const fromId = (t) =>
      t
        .replace(/_/g, ' ')
        .replace(/-LRB-/g, '(')
        .replace(/-RRB-/g, ')')
        .replace(/-COLON-/g, ':');
    const fileId = (id) => id.replace(/\//g, '%2F');

    const zip = join(dest, 'wiki-pages.zip');
    const devPath = join(dest, 'dev.jsonl');
    execFileSync('curl', ['-fsSL', '-o', devPath, spec.devUrl]);
    execFileSync('curl', ['-fsSL', '-o', zip, spec.wikiUrl]);

    // Claims -> (query, evidence pages); NOT ENOUGH INFO claims have no page labels.
    const queries = [];
    const evidence = new Map();
    for (const line of readFileSync(devPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const claim = JSON.parse(line);
      if (claim.label === 'NOT ENOUGH INFO') continue;
      const pages = new Set();
      for (const group of claim.evidence) for (const ev of group) if (ev[2]) pages.add(ev[2]);
      if (pages.size === 0) continue;
      queries.push({ _id: String(claim.id), text: claim.claim });
      evidence.set(String(claim.id), pages);
    }
    const cited = new Set([...evidence.values()].flatMap((pages) => [...pages]));

    const tree = join(dest, 'tree');
    mkdirSync(tree, { recursive: true });
    const kept = new Set();
    const idLine = /^\{"id": "((?:[^"\\]|\\.)*)"/;
    for (let shard = 1; shard <= 109; shard++) {
      const name = `wiki-pages/wiki-${String(shard).padStart(3, '0')}.jsonl`;
      const raw = execFileSync('unzip', ['-p', zip, name], { maxBuffer: 512 * 1024 * 1024, encoding: 'utf8' });
      for (const line of raw.split('\n')) {
        const m = idLine.exec(line);
        if (!m) continue;
        const id = m[1].includes('\\') ? JSON.parse(`"${m[1]}"`) : m[1];
        if (!cited.has(id) || kept.has(id)) continue;
        const doc = JSON.parse(line);
        const targets = new Set();
        for (const sentence of doc.lines.split('\n')) {
          const cols = sentence.split('\t');
          for (let i = 3; i < cols.length; i += 2) if (cols[i]) targets.add(toId(cols[i]));
        }
        targets.delete(id);
        const links = targets.size ? `\n\nLinks: ${[...targets].map((t) => `[[${fileId(t)}]]`).join(' ')}\n` : '';
        writeFileSync(join(tree, `${fileId(id)}.md`), `---\ntitle: ${JSON.stringify(fromId(id))}\n---\n\n${fromId(doc.text)}\n${links}`);
        kept.add(id);
      }
    }
    writeFileSync(join(tree, 'sense.config.json'), '{"version":1,"scan":{"include":["**/*.md"]},"queries":{}}');
    execFileSync('rm', [zip]);

    // Labels in BEIR format, restricted to pages that made it into the tree.
    const labels = join(dest, 'labels');
    mkdirSync(labels, { recursive: true });
    const qrels = ['query-id\tcorpus-id\tscore'];
    const keptQueries = [];
    for (const q of queries) {
      const pages = [...evidence.get(q._id)].filter((p) => kept.has(p));
      if (pages.length === 0) continue;
      keptQueries.push(q);
      for (const p of pages) qrels.push(`${q._id}\t${fileId(p)}\t1`);
    }
    writeFileSync(join(labels, 'queries.jsonl'), `${keptQueries.map((q) => JSON.stringify(q)).join('\n')}\n`);
    writeFileSync(join(labels, 'test.tsv'), `${qrels.join('\n')}\n`);
    console.error(`fever: ${kept.size} pages (${cited.size} cited), ${keptQueries.length} claims`);
  },
};

BUILDERS.replicate = (spec, dest) => {
  const src = corpusPath(spec.source);
  for (let i = 1; i <= spec.copies; i++) {
    const copy = join(dest, `copy${i}`);
    execFileSync('cp', ['-R', src, copy]);
    execFileSync('rm', ['-rf', join(copy, '.git'), join(copy, '.sense'), join(copy, 'sense.config.json')]);
  }
  writeFileSync(join(dest, 'sense.config.json'), '{"version":1,"scan":{"include":["**/*.md"]},"queries":{}}');
};

// Synthetic tree for shape sweeps (benchmark/sweep.mjs): every dimension holds the rest of
// these params at hub-like values and varies one. Everything derives from spec.seed via
// mulberry32, so the same spec produces a byte-identical tree (verified in the sweep smoke test).
BUILDERS.synthetic = (spec, dest) => {
  const cfg = { ...SYNTHETIC_DEFAULTS, ...spec };
  const rand = mulberry32(cfg.seed);
  const pickWord = zipfPicker(rand);

  // A few subdirectories at varying depth -- "spread across levels", not a balanced tree.
  // presets mode wants the opposite: one fixed, named folder per declared preset, so each
  // preset's include glob covers exactly (and only) its own folder.
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

    const fm = { title: `${pickWord()} ${pickWord()}` };
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
    writeFileSync(join(dest, 'sense.config.json'), `${JSON.stringify({ version: 3, presets, queries: {} }, null, 2)}\n`);
  } else {
    const features = cfg.embed ? ', "features": {"embed": true}' : '';
    writeFileSync(join(dest, 'sense.config.json'), `{"version": 2, "scan": {"include": ["**/*.md"]}, "queries": {}${features}}\n`);
  }
};

// Synthetic tree for a param spec (not a catalog name) -- lets sweep.mjs request corpora
// that the CORPORA table never lists, cached the same way as everything else.
export function syntheticPath(spec) {
  return cached(specKey(spec), (staging) => BUILDERS.synthetic(spec, staging));
}

function entryDir(name) {
  const spec = CORPORA[name];
  if (!spec) return null;
  const key = `${name}-${(spec.commit ?? spec.version).slice(0, 8)}`;
  return cached(key, (staging) => BUILDERS[spec.type](spec, staging));
}

// The markdown tree for a corpus name; null for unknown names.
export function corpusPath(name) {
  const dir = entryDir(name);
  if (dir === null) return null;
  const tree = join(dir, 'tree');
  return existsSync(tree) ? tree : dir;
}

// Query/qrels directory for labeled corpora; null when the corpus has none (or is unknown).
export function corpusLabels(name) {
  const dir = entryDir(name);
  if (dir === null) return null;
  const labels = join(dir, 'labels');
  return existsSync(labels) ? labels : null;
}
