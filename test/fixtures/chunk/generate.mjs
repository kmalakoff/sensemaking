#!/usr/bin/env node
// Regenerates expected.json via the BUILT dist/esm (npm run build first), so the pin matches
// the published package. A regression oracle, not correctness: known-wrong behavior (meta.json "reason") pins as-is.

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
  out.text = extractText(block);
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
