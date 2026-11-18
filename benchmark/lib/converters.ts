// Converters from downloaded sources to markdown trees. CONVERTER_REVISION is part of every
// downloaded set's cache key; bump it whenever a converter's output can change
// (test/integration/benchmark-cache.test.ts fails until the recorded source hash follows).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { downloadVerified } from './cache.ts';
import { mulberry32 } from './prng.ts';
import { writeTreeConfig } from './tree-config.ts';

export const CONVERTER_REVISION = 1;
// Files whose source decides a converted tree's bytes.
export const CONVERTER_SOURCES = ['benchmark/lib/converters.ts', 'benchmark/lib/prng.ts', 'benchmark/lib/tree-config.ts'];

// Every downloaded archive or file carries the sha256 it must have; the key hashes the whole spec.
export interface BeirSpec {
  type: 'beir';
  url: string;
  sha256: string;
}
export interface FeverSpec {
  type: 'fever';
  wikiUrl: string;
  wikiSha256: string;
  devUrl: string;
  devSha256: string;
}
export interface MiraclSpec {
  type: 'miracl';
  lang: string;
  shards: number;
  targetDocs: number;
  labelsSha: string;
  corpusSha: string;
  seed: number;
}
interface MiraclDoc {
  docid: string;
  title?: unknown;
  text: string;
}

// BEIR zips carry corpus.jsonl + queries.jsonl + qrels/*.tsv. Docs become one md file each
// (id as filename, title in frontmatter, text as body); queries/qrels land in labels/.
export async function buildBeir(spec: BeirSpec, dest: string) {
  const zip = join(dest, 'dataset.zip');
  await downloadVerified(spec.url, zip, spec.sha256);
  execFileSync('unzip', ['-q', zip, '-d', dest]);
  execFileSync('rm', [zip]);
  const inner = join(dest, 'nfcorpus');
  const tree = join(dest, 'tree');
  const labels = join(dest, 'labels');
  mkdirSync(tree, { recursive: true });
  mkdirSync(labels, { recursive: true });
  for (const line of readFileSync(join(inner, 'corpus.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const doc: { _id: string | number; title?: unknown; text: string } = JSON.parse(line);
    const title = JSON.stringify(doc.title ?? '');
    writeFileSync(join(tree, `${doc._id}.md`), `---\ntitle: ${title}\n---\n\n${doc.text}\n`);
  }
  writeTreeConfig(tree, { version: 1, scan: { include: ['**/*.md'] }, queries: {} });
  execFileSync('cp', [join(inner, 'queries.jsonl'), labels]);
  execFileSync('bash', ['-c', `cp ${JSON.stringify(join(inner, 'qrels'))}/*.tsv ${JSON.stringify(labels)}`]);
}

// Pages arrive as jsonl shards in a 1.7GB zip; `lines` annotates sentences with (anchor,
// target) pairs. Targets are display titles, so they normalize to id form to match filenames.
export async function buildFever(spec: FeverSpec, dest: string) {
  const toId = (t: string) => t.replace(/ /g, '_').replace(/\(/g, '-LRB-').replace(/\)/g, '-RRB-').replace(/:/g, '-COLON-');
  const fromId = (t: string) =>
    t
      .replace(/_/g, ' ')
      .replace(/-LRB-/g, '(')
      .replace(/-RRB-/g, ')')
      .replace(/-COLON-/g, ':');
  const fileId = (id: string) => id.replace(/\//g, '%2F');

  const zip = join(dest, 'wiki-pages.zip');
  const devPath = join(dest, 'dev.jsonl');
  await downloadVerified(spec.devUrl, devPath, spec.devSha256);
  await downloadVerified(spec.wikiUrl, zip, spec.wikiSha256);

  // Claims -> (query, evidence pages); NOT ENOUGH INFO claims have no page labels.
  const queries: { _id: string; text: string }[] = [];
  const evidence = new Map<string, Set<string>>();
  for (const line of readFileSync(devPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const claim: { label: string; id: string | number; claim: string; evidence: [unknown, unknown, string | null, ...unknown[]][][] } = JSON.parse(line);
    if (claim.label === 'NOT ENOUGH INFO') continue;
    const pages = new Set<string>();
    for (const group of claim.evidence) for (const ev of group) if (ev[2]) pages.add(ev[2]);
    if (pages.size === 0) continue;
    queries.push({ _id: String(claim.id), text: claim.claim });
    evidence.set(String(claim.id), pages);
  }
  const cited = new Set([...evidence.values()].flatMap((pages) => [...pages]));

  const tree = join(dest, 'tree');
  mkdirSync(tree, { recursive: true });
  const kept = new Set<string>();
  const idLine = /^\{"id": "((?:[^"\\]|\\.)*)"/;
  for (let shard = 1; shard <= 109; shard++) {
    const name = `wiki-pages/wiki-${String(shard).padStart(3, '0')}.jsonl`;
    const raw = execFileSync('unzip', ['-p', zip, name], { maxBuffer: 512 * 1024 * 1024, encoding: 'utf8' });
    for (const line of raw.split('\n')) {
      const m = idLine.exec(line);
      if (!m) continue;
      const id: string = m[1].includes('\\') ? JSON.parse(`"${m[1]}"`) : m[1];
      if (!cited.has(id) || kept.has(id)) continue;
      const doc: { lines: string; text: string } = JSON.parse(line);
      const targets = new Set<string>();
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
  writeTreeConfig(tree, { version: 1, scan: { include: ['**/*.md'] }, queries: {} });
  execFileSync('rm', [zip]);

  // Labels in BEIR format, restricted to pages that made it into the tree.
  const labels = join(dest, 'labels');
  mkdirSync(labels, { recursive: true });
  const qrels = ['query-id\tcorpus-id\tscore'];
  const keptQueries = [];
  for (const q of queries) {
    const pages = [...(evidence.get(q._id) as Set<string>)].filter((p) => kept.has(p));
    if (pages.length === 0) continue;
    keptQueries.push(q);
    for (const p of pages) qrels.push(`${q._id}\t${fileId(p)}\t1`);
  }
  writeFileSync(join(labels, 'queries.jsonl'), `${keptQueries.map((q) => JSON.stringify(q)).join('\n')}\n`);
  writeFileSync(join(labels, 'test.tsv'), `${qrels.join('\n')}\n`);
  console.error(`fever: ${kept.size} pages (${cited.size} cited), ${keptQueries.length} claims`);
}

// Topics/qrels from miracl/miracl; passages from miracl/miracl-corpus (gzipped shards, no
// docid->shard index, so every shard is scanned). Distractors reservoir-sample down to targetDocs.
export function buildMiracl(spec: MiraclSpec, dest: string) {
  const { lang, shards, targetDocs, labelsSha, corpusSha, seed } = spec;
  const topicsPath = join(dest, 'topics.tsv');
  const qrelsPath = join(dest, 'qrels.tsv');
  execFileSync('curl', ['-fsSL', '-o', topicsPath, `https://huggingface.co/datasets/miracl/miracl/resolve/${labelsSha}/miracl-v1.0-${lang}/topics/topics.miracl-v1.0-${lang}-dev.tsv`]);
  execFileSync('curl', ['-fsSL', '-o', qrelsPath, `https://huggingface.co/datasets/miracl/miracl/resolve/${labelsSha}/miracl-v1.0-${lang}/qrels/qrels.miracl-v1.0-${lang}-dev.tsv`]);

  const topics = new Map<string, string>();
  for (const line of readFileSync(topicsPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const [qid, text] = line.split('\t');
    topics.set(qid, text);
  }
  const qrelRows = [];
  const judged = new Set<string>();
  for (const line of readFileSync(qrelsPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const [qid, , docid, score] = line.split('\t');
    qrelRows.push({ qid, docid, score });
    judged.add(docid);
  }
  const toFileId = (docid: string) => docid.replace('#', '__p');

  const tree = join(dest, 'tree');
  mkdirSync(tree, { recursive: true });
  const rand = mulberry32(seed);
  const distractorsNeeded = Math.max(0, targetDocs - judged.size);
  const reservoir: MiraclDoc[] = [];
  let candidatesSeen = 0;
  const kept = new Set<string>();
  const writeDoc = (doc: MiraclDoc) => {
    writeFileSync(join(tree, `${toFileId(doc.docid)}.md`), `---\ntitle: ${JSON.stringify(doc.title ?? '')}\n---\n\n${doc.text}\n`);
    kept.add(doc.docid);
  };

  for (let shard = 0; shard < shards; shard++) {
    const gz = join(dest, 'shard.jsonl.gz');
    execFileSync('curl', ['-fsSL', '-o', gz, `https://huggingface.co/datasets/miracl/miracl-corpus/resolve/${corpusSha}/miracl-corpus-v1.0-${lang}/docs-${shard}.jsonl.gz`]);
    const raw = execFileSync('gunzip', ['-c', gz], { maxBuffer: 2 * 1024 * 1024 * 1024, encoding: 'utf8' });
    rmSync(gz);
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const doc: MiraclDoc = JSON.parse(line);
      if (judged.has(doc.docid)) {
        if (!kept.has(doc.docid)) writeDoc(doc);
        continue;
      }
      candidatesSeen++;
      if (reservoir.length < distractorsNeeded) {
        reservoir.push(doc);
      } else if (distractorsNeeded > 0) {
        const j = Math.floor(rand() * candidatesSeen);
        if (j < distractorsNeeded) reservoir[j] = doc;
      }
    }
    console.error(`miracl-${lang}: shard ${shard + 1}/${shards}, judged kept ${kept.size}/${judged.size}, candidates seen ${candidatesSeen}`);
  }
  for (const doc of reservoir) writeDoc(doc);
  writeTreeConfig(tree, { version: 1, scan: { include: ['**/*.md'] }, queries: {} });

  // Labels: BEIR 3-column test.tsv, MIRACL's dev split standing in as the "test" split.
  // Queries restricted to ones with a judged doc in the tree.
  const labels = join(dest, 'labels');
  mkdirSync(labels, { recursive: true });
  const keptQueries = [];
  const seenQids = new Set();
  const testRows = ['query-id\tcorpus-id\tscore'];
  for (const row of qrelRows) {
    testRows.push(`${row.qid}\t${toFileId(row.docid)}\t${row.score}`);
    if (!seenQids.has(row.qid) && topics.has(row.qid)) {
      seenQids.add(row.qid);
      keptQueries.push({ _id: row.qid, text: topics.get(row.qid) });
    }
  }
  writeFileSync(join(labels, 'queries.jsonl'), `${keptQueries.map((q) => JSON.stringify(q)).join('\n')}\n`);
  writeFileSync(join(labels, 'test.tsv'), `${testRows.join('\n')}\n`);
  console.error(`miracl-${lang}: ${kept.size} docs (${judged.size} judged + ${reservoir.length} distractor), ${keptQueries.length} queries`);
}
