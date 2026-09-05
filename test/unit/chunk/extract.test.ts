import assert from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractText } from '../../../src/chunk/extract.ts';
import { parse } from '../../../src/chunk/parse.ts';
import type { Block } from '../../../src/chunk/types.ts';

function extractParagraph(body: string): string {
  return extractText(parse(body)[0]);
}

// Regression suite over test/fixtures/chunk/cases/: hub-corpus samples plus synthetic
// flavor-inertness pairs; every input.md/expected.json is committed, so no corpus needed on CI.

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
  const out: ExpectedBlock = { endLine: block.endLine, startLine: block.startLine, text: extractText(block), type: block.type };
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
    assert.ok(!extractText(paragraph).includes('[[VARIABLE_NAME]]'), 'decided: Obsidian grammar claims the [[...]] position');
  });

  // A callout marker is defined by position (head of a blockquote), not by authorial intent,
  // so a quote that happens to open with "[!word]" is a callout by the same grammar.
  it('pair-callout-plain: a blockquote-head "[!word]" is a callout marker by position, not intent', () => {
    const { body } = readCase('pair-callout-plain');
    const [blockquote] = parse(body);
    assert.ok(body.includes('[!important]'), 'fixture must still contain the literal construct');
    assert.ok(!extractText(blockquote).includes('[!important]'), 'decided: Obsidian grammar claims the blockquote-head position');
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

// mdast values were already entity-decoded, so kept text must decode too; code and html stay raw.
describe('extractText: character references decode in kept text (mdast parity)', () => {
  it('a named entity decodes, a numeric and a hex entity decode the same way', () => {
    assert.equal(extractParagraph('x &amp; y'), 'x & y');
    assert.equal(extractParagraph('x &#65; y'), 'x A y');
    assert.equal(extractParagraph('x &#x2192; y'), 'x → y');
  });

  it('a decoded entity is plain text: &lt; stays literal, not an html tag', () => {
    assert.equal(extractParagraph('x &lt;b&gt; c'), 'x <b> c');
  });

  it('an unknown or incomplete reference is kept as written', () => {
    assert.equal(extractParagraph('x &noentity; y'), 'x &noentity; y');
    assert.equal(extractParagraph('x &amp y'), 'x &amp y');
  });

  it('a backslash-escaped & is not an entity', () => {
    assert.equal(extractParagraph('x \\&amp; y'), 'x &amp; y');
  });

  it('an entity right after an email autolink still decodes (the span does not swallow it)', () => {
    assert.equal(extractParagraph('mail a@b.co&amp; x'), 'mail & x');
  });

  it('an entity trail after a url autolink decodes where the old trail machine left it', () => {
    assert.equal(extractParagraph('x https://a.b/c&amp; z'), 'x & z');
  });

  it('a link label decodes like any other kept text', () => {
    assert.equal(extractParagraph('[a&amp;b](https://a.b/c)'), 'a&b');
  });

  it('code stays raw: an entity in inline code is not decoded', () => {
    assert.equal(extractParagraph('x `&amp;` y'), 'x &amp; y');
  });
});

// A block is extracted more than once in one build: parse() pre-extracts every heading, strip.ts
// re-extracts all blocks for the search text, and group.ts extracts again when chunking. So
// extraction must never write to the tokens Block.node holds, or the second value differs.
describe('extractText: extraction is pure, so a block re-extracts to the same value', () => {
  const thrice = (body: string): string[] => {
    const block = parse(body)[0];
    return [extractText(block), extractText(block), extractText(block)];
  };

  it('an autolink whose trail the GFM machine trims does not grow that trail on re-extraction', () => {
    assert.deepEqual(thrice('https://x.com/a_b_ rest'), ['_ rest', '_ rest', '_ rest']);
  });

  it('a heading holding such an autolink extracts the same text parse() stored on it', () => {
    const block = parse('# https://x.com/a_b_ rest')[0];
    assert.equal(extractText(block), block.text);
  });

  it('a task item keeps its one dropped marker space on every extraction', () => {
    assert.deepEqual(thrice('- [ ]  two spaces'), [' two spaces', ' two spaces', ' two spaces']);
  });
});

// Each case below matched the old micromark+mdast pipeline and regressed in the token rewrite;
// the value asserted is the old pipeline's own, so the swap stays a swap and not a change.
describe('extractText: token-rewrite regressions against the old pipeline', () => {
  it('a url keeps its trail when its path holds an @, which is not an email', () => {
    assert.equal(extractParagraph('(See http://example.com/@a(b).)'), '(See .)');
    assert.equal(extractParagraph('mail a@b.co rest'), 'mail  rest');
  });

  it("an image's alt keeps a link's display text, which alt is plain text for", () => {
    assert.equal(extractParagraph('![see http://x.com here](i.png)'), 'see http://x.com here');
    assert.equal(extractParagraph('![<http://x.com>](i.png)'), 'http://x.com');
  });

  it('only the task-list checkbox drops a space, not any leading inline html', () => {
    assert.equal(extractText(parse('- <br> continued')[0]), ' continued');
    assert.equal(extractText(parse('- [ ] real task')[0]), 'real task');
  });
});
