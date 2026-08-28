import assert from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { extractText } from '../../../src/chunk/extract.ts';
import { parse } from '../../../src/chunk/parse.ts';
import type { Block } from '../../../src/chunk/types.ts';

function extractParagraph(body: string): string {
  const tree = fromMarkdown(body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  return extractText(tree.children[0]);
}

// Regression suite over test/fixtures/chunk/cases/: real hub-corpus samples plus synthetic
// flavor-inertness pairs, pinned by test/fixtures/chunk/generate.mjs. No corpus needed on CI --
// every input.md and expected.json is committed.

interface ExpectedBlock {
  depth?: number;
  endLine: number;
  startLine: number;
  text: string;
  type: string;
}

interface ExpectedCase {
  blocks: ExpectedBlock[];
}

const casesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'chunk', 'cases');

// Shape must match generate.mjs's blockToJson exactly, or every case fails on key mismatch.
function blockToJson(block: Block): ExpectedBlock {
  const out: ExpectedBlock = { endLine: block.endLine, startLine: block.startLine, text: extractText(block.node), type: block.type };
  if (block.depth !== undefined) out.depth = block.depth;
  return out;
}

function readCase(name: string): { body: string; expected: ExpectedCase } {
  const dir = join(casesDir, name);
  const body = readFileSync(join(dir, 'input.md'), 'utf8');
  const expected: ExpectedCase = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8'));
  return { body, expected };
}

const caseNames = readdirSync(casesDir)
  .filter((name) => statSync(join(casesDir, name)).isDirectory())
  .sort();

describe('chunk fixtures: parse + extract pinned against committed cases', () => {
  for (const name of caseNames) {
    it(name, () => {
      const { body, expected } = readCase(name);
      const actual: ExpectedCase = { blocks: parse(body).map(blockToJson) };
      assert.deepStrictEqual(actual, expected, `${name}: parse+extract diverged from the pinned fixture`);
    });
  }
});

describe('chunk fixtures: decided flavor behavior (Obsidian grammar wins the position)', () => {
  // [[...]] has no plain-markdown meaning, so wherever it appears Obsidian's grammar claims
  // it -- matching the words layer, which resolves wikilinks the same way regardless of intent.
  it('pair-wikilink-plain: wikilinks resolve wherever they appear, matching the words layer', () => {
    const { body } = readCase('pair-wikilink-plain');
    const [, paragraph] = parse(body);
    assert.ok(body.includes('[[VARIABLE_NAME]]'), 'fixture must still contain the literal construct');
    assert.ok(!extractText(paragraph.node).includes('[[VARIABLE_NAME]]'), 'decided: Obsidian grammar claims the [[...]] position');
  });

  // A callout marker is defined by position (head of a blockquote), not by authorial intent,
  // so a quote that happens to open with "[!word]" is a callout by the same grammar.
  it('pair-callout-plain: a blockquote-head "[!word]" is a callout marker by position, not intent', () => {
    const { body } = readCase('pair-callout-plain');
    const [blockquote] = parse(body);
    assert.ok(body.includes('[!important]'), 'fixture must still contain the literal construct');
    assert.ok(!extractText(blockquote.node).includes('[!important]'), 'decided: Obsidian grammar claims the blockquote-head position');
  });
});

describe('extractText: autolinks contribute nothing (D12)', () => {
  it('a bare URL autolink contributes nothing', () => {
    assert.equal(extractParagraph('See http://example.com here.'), 'See  here.');
  });

  it('an angle-bracket autolink contributes nothing', () => {
    assert.equal(extractParagraph('See <http://example.com> here.'), 'See  here.');
  });

  it('a www. autolink (url gains an http:// scheme) contributes nothing', () => {
    assert.equal(extractParagraph('See www.example.com here.'), 'See  here.');
  });

  it('an email autolink (url gains a mailto: scheme) contributes nothing', () => {
    assert.equal(extractParagraph('Email foo@example.com please.'), 'Email  please.');
  });

  it('a link with real display text keeps the text', () => {
    assert.equal(extractParagraph('See [the docs](http://example.com) here.'), 'See the docs here.');
  });

  it('display text that merely resembles the target, but is not what the url resolves to, is kept', () => {
    assert.equal(extractParagraph('See [www.example.com](http://example.com/other) here.'), 'See www.example.com here.');
  });
});
