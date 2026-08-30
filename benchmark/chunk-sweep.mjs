#!/usr/bin/env node
// Corpus sweep for src/chunk/: a sha256 digest over every block's type/extent/text in stable
// (path, document) order. A release-gate tool, not a test: digest drift is a signal, not a failure.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { walkMd } from './lib/measure.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
let OUT = null;
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out') {
    OUT = resolve(argv[++i]);
    continue;
  }
  positional.push(argv[i]);
}
const [corpusDir] = positional;
if (!corpusDir) {
  console.error('usage: node benchmark/chunk-sweep.mjs <corpus-dir> [--out file.json]');
  process.exit(2);
}
const tree = resolve(corpusDir);

const { parse, extractText } = await import(pathToFileURL(join(ROOT, 'dist', 'esm', 'chunk', 'index.js')).href);

const files = walkMd(tree);
const blockCountsByType = {};
const errors = [];
let totalBlocks = 0;
let totalChars = 0;
const hash = createHash('sha256');

const started = process.hrtime.bigint();
for (const rel of files) {
  let body;
  try {
    body = readFileSync(join(tree, rel), 'utf8');
  } catch (err) {
    errors.push({ path: rel, message: err.message });
    continue;
  }
  try {
    const blocks = parse(body);
    for (const block of blocks) {
      const text = extractText(block.node);
      totalBlocks++;
      totalChars += text.length;
      blockCountsByType[block.type] = (blockCountsByType[block.type] ?? 0) + 1;
      hash.update(rel);
      hash.update('\n');
      hash.update(`${block.type}\t${block.startLine}\t${block.endLine}\t${block.depth ?? ''}\n`);
      hash.update(text);
      hash.update('\n');
    }
  } catch (err) {
    errors.push({ path: rel, message: err.message });
  }
}
const elapsedMs = Math.round(Number(process.hrtime.bigint() - started) / 1e6);

const result = {
  corpus: tree,
  filesFound: files.length,
  filesParsed: files.length - errors.length,
  errorCount: errors.length,
  errors: errors.slice(0, 20),
  totalBlocks,
  totalChars,
  blockCountsByType,
  elapsedMs,
  digest: hash.digest('hex'),
  date: new Date().toISOString(),
  node: process.version,
};

console.log(`corpus:        ${result.corpus}`);
console.log(`files found:   ${result.filesFound}`);
console.log(`files parsed:  ${result.filesParsed}`);
console.log(`errors:        ${result.errorCount}`);
if (errors.length) for (const e of result.errors) console.log(`  ${e.path}: ${e.message}`);
console.log(`total blocks:  ${result.totalBlocks}`);
console.log(`total chars:   ${result.totalChars}`);
console.log('blocks by type:');
for (const type of Object.keys(blockCountsByType).sort()) console.log(`  ${type}: ${blockCountsByType[type]}`);
console.log(`elapsed:       ${result.elapsedMs}ms`);
console.log(`digest:        ${result.digest}`);

if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`wrote ${OUT}`);
}

process.exit(result.errorCount === 0 ? 0 : 1);
