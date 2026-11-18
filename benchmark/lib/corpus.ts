// Declarative corpus specs, one builder per source type, resolved through the fetch-once cache.
// corpusPath(name) returns the markdown tree; corpusLabels(name) the query/qrels dir, or null.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE_DIR, cached, cachePath, contentKey, SHARED_CACHE_DIR } from './cache.ts';
import { type BeirSpec, buildBeir, buildFever, buildMiracl, CONVERTER_REVISION, type FeverSpec, type MiraclSpec } from './converters.ts';
import { buildSynthetic, SYNTHETIC_DEFAULTS, type SyntheticOptions, syntheticSpecKey } from './synthetic.ts';
import { writeTreeConfig } from './tree-config.ts';

// Bump when the replicate builder's output can change; part of every replicate key.
const REPLICATE_REVISION = 1;

interface GitSpec {
  type: 'git';
  repo: string;
  commit: string;
}
interface ReplicateSpec {
  type: 'replicate';
  source: 'obsidian-hub';
  copies: number;
}
interface SyntheticSpec extends SyntheticOptions {
  type: 'synthetic';
}
export type CorpusSpec = GitSpec | BeirSpec | FeverSpec | MiraclSpec | ReplicateSpec | SyntheticSpec;
type Builder<S> = (spec: S, dest: string) => void | Promise<void>;
interface Builders {
  git: Builder<GitSpec>;
  beir: Builder<BeirSpec>;
  fever: Builder<FeverSpec>;
  miracl: Builder<MiraclSpec>;
  replicate?: Builder<ReplicateSpec>;
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
    sha256: 'efe5be03f8c5b86a5870102d0599d227c8c6e2484328e68c6522560385671b0b',
  },
  // FEVER: claims labeled with Wikipedia evidence pages, sentence links kept as wikilinks --
  // the only corpus that measures link fusion. Scale rows replicate one corpus N times.
  'obsidian-hub-x2': { type: 'replicate', source: 'obsidian-hub', copies: 2 },
  'obsidian-hub-x4': { type: 'replicate', source: 'obsidian-hub', copies: 4 },
  // Every fixed shape cliff in one tree: 1MB note, 200 headings/note, 100 links/note, 300
  // fields. The release gate runs it so a cliff regression moves a row instead of shipping.
  stress: { type: 'synthetic', notes: 2000, noteTokens: 500, headingsPerNote: 200, linksPerNote: 100, distinctFields: 300, fieldsPerNote: 8, seed: 42, bigNoteBytes: 1_000_000 },
  fever: {
    type: 'fever',
    wikiUrl: 'https://fever.ai/download/fever/wiki-pages.zip',
    wikiSha256: '4b06d95da6adf7fe02d2796176c670dacccb21348da89cba4c50676ab99665f2',
    devUrl: 'https://fever.ai/download/fever/shared_task_dev.jsonl',
    devSha256: 'e89865bfe1b4dd054e03dd57d7241a6fde24862905f31117cf0cd719f7c78df7',
  },
  // MIRACL per-language: dev-split judged passages (the only publicly-labeled split) plus
  // sampled distractors to reach ~3-5k docs/language. HF datasets pinned by commit sha.
  'miracl-de': { type: 'miracl', lang: 'de', shards: 32, targetDocs: 4000, labelsSha: '5be20db9509754dadad47689368639fcec739c00', corpusSha: 'd921ec7e349ce0d28daf30b2da9da5ee698bef0d', seed: 100 },
  'miracl-ja': { type: 'miracl', lang: 'ja', shards: 14, targetDocs: 4000, labelsSha: '5be20db9509754dadad47689368639fcec739c00', corpusSha: 'd921ec7e349ce0d28daf30b2da9da5ee698bef0d', seed: 101 },
  'miracl-ru': { type: 'miracl', lang: 'ru', shards: 20, targetDocs: 4000, labelsSha: '5be20db9509754dadad47689368639fcec739c00', corpusSha: 'd921ec7e349ce0d28daf30b2da9da5ee698bef0d', seed: 102 },
  'miracl-zh': { type: 'miracl', lang: 'zh', shards: 10, targetDocs: 4000, labelsSha: '5be20db9509754dadad47689368639fcec739c00', corpusSha: 'd921ec7e349ce0d28daf30b2da9da5ee698bef0d', seed: 103 },
} satisfies Record<string, CorpusSpec>;

export const CORPUS_NAMES = Object.keys(CORPORA);

const BUILDERS: Builders = {
  git(spec, dest) {
    execFileSync('git', ['clone', '--quiet', spec.repo, dest], { stdio: ['ignore', 'ignore', 'inherit'] });
    execFileSync('git', ['-C', dest, 'checkout', '--quiet', spec.commit]);
  },
  beir: buildBeir,
  fever: buildFever,
  miracl: buildMiracl,
};

// Copies come from the pinned commit's index, not the working folder: Finder and Obsidian leave files there.
BUILDERS.replicate = async (spec, dest) => {
  const src = (await corpusPath(spec.source)) as string;
  execFileSync('git', ['-C', src, 'diff', '--quiet', '--cached', 'HEAD']);
  for (let i = 1; i <= spec.copies; i++) {
    const copy = join(dest, `copy${i}`);
    mkdirSync(copy, { recursive: true });
    execFileSync('git', ['-C', src, 'checkout-index', '--all', `--prefix=${copy}/`]);
  }
  writeTreeConfig(dest, { version: 1, scan: { include: ['**/*.md'] }, queries: {} });
};

// Synthetic tree for a param spec (not a catalog name) -- lets sweep.ts request corpora
// that the CORPORA table never lists, cached the same way as everything else.
export function syntheticPath(spec: SyntheticOptions) {
  return cached(
    syntheticSpecKey(spec),
    {
      build: (staging) => buildSynthetic(spec, staging),
      verify: (dir) => markdownCount(dir) === { ...SYNTHETIC_DEFAULTS, ...spec }.notes,
    },
    SHARED_CACHE_DIR
  );
}

// The key names the content: the corpus name plus a hash of every source hash or pinned commit and
// every parameter that shapes the output. Specs hold no hand-set label.
export function corpusSpecKey(name: string, spec: CorpusSpec, replicateRevision = REPLICATE_REVISION, generatorRevision?: number, converterRevision = CONVERTER_REVISION) {
  switch (spec.type) {
    case 'git':
      return `${name}-${spec.commit.slice(0, 8)}`;
    case 'replicate':
      return contentKey(name, { source: CORPORA[spec.source].commit, copies: spec.copies, revision: replicateRevision });
    case 'synthetic': {
      const { type: _type, ...options } = spec;
      return syntheticSpecKey(options, generatorRevision);
    }
    default:
      return contentKey(name, { ...spec, converterRevision });
  }
}

export function corpusEntryKey(name: string) {
  const spec: CorpusSpec | undefined = CORPORA[name as keyof typeof CORPORA];
  return spec ? corpusSpecKey(name, spec) : null;
}

// Everything is shared across worktrees except a git checkout: the Obsidian oracle opens that
// folder as a registered vault and Obsidian writes .obsidian/workspace.json into it, so each checkout keeps its own.
function entryCacheDir(spec: CorpusSpec, root?: string) {
  const dir = root === undefined ? CACHE_DIR : join(root, '.cache');
  return spec.type === 'git' ? dir : join(dir, 'shared');
}

function markdownCount(dir: string) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { recursive: true }).filter((path) => String(path).endsWith('.md')).length;
}

// What a finished entry holds, by source type. The harness rewrites notes and configs inside a
// corpus after it is built, so only files it never touches are checked.
export function entryComplete(spec: CorpusSpec, dir: string) {
  const has = (...paths: string[]) => paths.every((path) => existsSync(join(dir, path)));
  switch (spec.type) {
    case 'git':
      return has('.git') && spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim() === spec.commit;
    case 'beir':
      return has('labels/queries.jsonl') && markdownCount(join(dir, 'tree')) > 0;
    case 'fever':
      return has('dev.jsonl', 'labels') && markdownCount(join(dir, 'tree')) > 0;
    case 'miracl':
      return has('labels/queries.jsonl', 'labels/test.tsv') && markdownCount(join(dir, 'tree')) > 0;
    case 'replicate':
      return Array.from({ length: spec.copies }, (_, i) => `copy${i + 1}`).every((copy) => has(copy));
    case 'synthetic':
      return markdownCount(dir) === { ...SYNTHETIC_DEFAULTS, ...spec }.notes;
  }
}

// Where a corpus entry lives under a package root, built or not; null for unknown names.
export function corpusEntryDir(name: string, root: string) {
  const key = corpusEntryKey(name);
  return key === null ? null : cachePath(key, entryCacheDir(CORPORA[name as keyof typeof CORPORA], root));
}

function entryDir(name: string, root?: string) {
  const key = corpusEntryKey(name);
  if (key === null) return null;
  const spec = CORPORA[name as keyof typeof CORPORA] as CorpusSpec;
  const build =
    spec.type === 'synthetic'
      ? (staging: string) => {
          const { type: _type, ...options } = spec;
          return buildSynthetic(options, staging);
        }
      : (staging: string) => (BUILDERS[spec.type] as Builder<CorpusSpec>)(spec, staging);
  return cached(key, { build, verify: (dir) => entryComplete(spec, dir) }, entryCacheDir(spec, root));
}

// The markdown tree for a corpus name; null for unknown names.
export function corpusPath(name: keyof typeof CORPORA, root?: string): Promise<string>;
export function corpusPath(name: string, root?: string): Promise<string | null>;
export async function corpusPath(name: string, root?: string) {
  const dir = await entryDir(name, root);
  if (dir === null) return null;
  const tree = join(dir, 'tree');
  return existsSync(tree) ? tree : dir;
}

// Query/qrels directory for labeled corpora; null when the corpus has none (or is unknown).
export async function corpusLabels(name: string) {
  const dir = await entryDir(name);
  if (dir === null) return null;
  const labels = join(dir, 'labels');
  return existsSync(labels) ? labels : null;
}

// Retained-evidence checks must stay read-only. A cache miss means reuse is unavailable; it must
// never turn a dry-run or report render into a corpus download.
export function cachedCorpusPaths(name: string, root: string) {
  const dir = corpusEntryDir(name, root);
  if (dir === null) return { tree: null, labels: null };
  if (!existsSync(dir)) return { tree: null, labels: null };
  const tree = join(dir, 'tree');
  const labels = join(dir, 'labels');
  return { tree: existsSync(tree) ? tree : dir, labels: existsSync(labels) ? labels : null };
}
