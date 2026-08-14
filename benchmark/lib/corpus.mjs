// Corpus catalog: declarative specs, one builder per source type, resolution through the
// fetch-once cache. corpusPath(name) returns the markdown tree; corpusLabels(name) returns
// the query/qrels directory for labeled datasets, or null.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cached } from './cache.mjs';

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
  // FEVER dev split: verifiable claims labeled with their Wikipedia evidence pages.
  // Pages keep their sentence link annotations as wikilinks -- the corpus that can
  // measure link fusion. Tree = only pages cited as evidence; links to pages outside
  // it are dead (dst NULL), as in a real partial tree.
  // Scale rows: the same real corpus replicated N times under one root. Tests the
  // per-query freshness stat-walk and reconcile at the note counts the README claims;
  // duplicate basenames across copies also stress link-ambiguity resolution.
  'obsidian-hub-x2': { type: 'replicate', source: 'obsidian-hub', copies: 2, version: 'x2-hub-1' },
  'obsidian-hub-x4': { type: 'replicate', source: 'obsidian-hub', copies: 4, version: 'x4-hub-1' },
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
  // FEVER wiki pages arrive as jsonl shards inside a 1.7GB zip (deleted after the build);
  // each page's `lines` field annotates sentences with (anchor, target) link pairs.
  // Targets are display-form titles; page ids escape punctuation (-LRB- etc.), so link
  // targets normalize to id form to match filenames. Labels convert to BEIR format.
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
