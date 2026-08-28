#!/usr/bin/env node
// Regenerates test/fixtures/chunk/cases/*/expected.json from the committed input.md files,
// running the BUILT src/chunk/ (dist/esm), never source directly, so what is pinned matches
// what a published package actually does. This is a regression oracle, not a correctness
// oracle: it pins accepted W1 behavior so a later change to src/chunk/ shows up as a diff.
// Known-wrong or known-incomplete behavior (see meta.json "reason" fields and the project
// report) is pinned as-is; fixing it is out of this script's scope.
//
//   npm run build && node test/fixtures/chunk/generate.mjs

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const casesDir = join(here, 'cases');
const distChunk = join(here, '..', '..', '..', 'dist', 'esm', 'chunk', 'index.js');

const { parse, extractText } = await import(distChunk);

function blockToJson(block) {
  const out = {};
  if (block.depth !== undefined) out.depth = block.depth;
  out.endLine = block.endLine;
  out.startLine = block.startLine;
  out.text = extractText(block.node);
  out.type = block.type;
  return out;
}

const caseNames = readdirSync(casesDir).filter((name) => statSync(join(casesDir, name)).isDirectory());
caseNames.sort();

let written = 0;
for (const name of caseNames) {
  const dir = join(casesDir, name);
  const inputPath = join(dir, 'input.md');
  const body = readFileSync(inputPath, 'utf8');
  const blocks = parse(body).map(blockToJson);
  const expected = { blocks };
  writeFileSync(join(dir, 'expected.json'), `${JSON.stringify(expected, null, 2)}\n`, 'utf8');
  written++;
}

console.log(`wrote expected.json for ${written} cases`);
