import assert from 'node:assert';
import { extractText } from '../../../src/chunk/extract.ts';
import { parse } from '../../../src/chunk/parse.ts';
import type { Block } from '../../../src/chunk/types.ts';

// parse(): block typing and line extents come straight from mdast's node.position, never a
// regex guess. extractText(): plain text of one mdast node, structure kept, markup dropped.

function types(blocks: Block[]): string[] {
  return blocks.map((b) => b.type);
}

describe('parse: fences', () => {
  it('a backtick fence is one code block, bounding paragraphs before and after', () => {
    const md = ['before', '', '```js', 'code line', '```', '', 'after'].join('\n');
    const blocks = parse(md);
    assert.deepEqual(types(blocks), ['paragraph', 'code', 'paragraph']);
    assert.deepEqual(
      blocks.map((b) => [b.startLine, b.endLine]),
      [
        [1, 1],
        [3, 5],
        [7, 7],
      ]
    );
  });

  it('a tilde fence is recognized the same way as a backtick fence', () => {
    const md = ['before', '', '~~~', 'code line', '~~~', '', 'after'].join('\n');
    const blocks = parse(md);
    assert.deepEqual(types(blocks), ['paragraph', 'code', 'paragraph']);
    assert.deepEqual([blocks[1].startLine, blocks[1].endLine], [3, 5]);
  });

  it('an unclosed fence runs to the end of the document', () => {
    const md = ['text before', '', '```js', 'const x = 1;', '# not-a-heading'].join('\n');
    const blocks = parse(md);
    assert.deepEqual(types(blocks), ['paragraph', 'code']);
    assert.deepEqual([blocks[1].startLine, blocks[1].endLine], [3, 5]);
  });

  it('a line that looks like a heading inside a fence is not a heading block', () => {
    const md = ['text before', '', '```js', 'const x = 1;', '# not-a-heading'].join('\n');
    const blocks = parse(md);
    assert.ok(blocks.every((b) => b.type !== 'heading'));
    assert.match(extractText(blocks[1].node), /# not-a-heading/);
  });
});

describe('parse: tables, lists, blockquotes', () => {
  it('a table (header + delimiter + 2 rows) is one table block spanning all four lines', () => {
    const md = ['| a | b |', '|---|---|', '| 1 | 2 |', '| 3 | 4 |'].join('\n');
    const blocks = parse(md);
    assert.deepEqual(types(blocks), ['table']);
    assert.deepEqual([blocks[0].startLine, blocks[0].endLine], [1, 4]);
  });

  it('a nested list with lazy continuation is one list block spanning every line', () => {
    const md = ['- item one', '  continued text', '  - nested a', '  - nested b', '- item two'].join('\n');
    const blocks = parse(md);
    assert.deepEqual(types(blocks), ['list']);
    assert.deepEqual([blocks[0].startLine, blocks[0].endLine], [1, 5]);
  });

  it('a blockquote is one blockquote block spanning its lines', () => {
    const md = ['> line one', '> line two'].join('\n');
    const blocks = parse(md);
    assert.deepEqual(types(blocks), ['blockquote']);
    assert.deepEqual([blocks[0].startLine, blocks[0].endLine], [1, 2]);
  });
});

describe('parse: CRLF line extents', () => {
  it('holds correct 1-indexed line numbers on a \\r\\n-joined document', () => {
    const md = ['# Title', '', 'Body para', '', '## Section', '', 'More text'].join('\r\n');
    const blocks = parse(md);
    assert.deepEqual(types(blocks), ['heading', 'paragraph', 'heading', 'paragraph']);
    assert.deepEqual(
      blocks.map((b) => [b.startLine, b.endLine]),
      [
        [1, 1],
        [3, 3],
        [5, 5],
        [7, 7],
      ]
    );
    assert.equal(blocks[0].text, 'Title');
    assert.equal(blocks[2].text, 'Section');
  });
});

describe('parse: setext headings', () => {
  it('an underline of = is depth 1, an underline of - is depth 2, both spanning title + underline', () => {
    const md = ['Title', '=====', '', 'Subtitle', '-----'].join('\n');
    const blocks = parse(md);
    assert.deepEqual(types(blocks), ['heading', 'heading']);
    assert.deepEqual(
      blocks.map((b) => [b.depth, b.text, b.startLine, b.endLine]),
      [
        [1, 'Title', 1, 2],
        [2, 'Subtitle', 4, 5],
      ]
    );
  });
});

describe('extract: F8 regression cases', () => {
  it('a table extracts cell text row by row, without pipes or the delimiter row', () => {
    const md = ['| a | b |', '|---|---|', '| 1 | 2 |', '| 3 | 4 |'].join('\n');
    const [block] = parse(md);
    assert.equal(extractText(block.node), 'a b\n1 2\n3 4');
  });

  it('a footnote definition keeps its text', () => {
    const md = ['para', '', '[^1]: footnote body here'].join('\n');
    const blocks = parse(md);
    const def = blocks.find((b) => b.type === 'other');
    assert.ok(def, 'footnote definition should parse as a block');
    assert.equal(extractText((def as Block).node), 'footnote body here');
  });

  it('an Obsidian callout marker is dropped but the callout body is kept', () => {
    const md = ['> [!warning] Title', '> body text'].join('\n');
    const [block] = parse(md);
    const text = extractText(block.node);
    assert.ok(!text.includes('[!warning]'), 'marker must not survive');
    assert.equal(text, 'Title\nbody text');
  });

  it('a literal [!bracket] mid-sentence in a plain paragraph is inert, not a callout', () => {
    const md = 'Use [!important] sparingly in prose.';
    const [block] = parse(md);
    assert.equal(extractText(block.node), 'Use [!important] sparingly in prose.');
  });

  it('a plain paragraph starting with [!bracket] outside any blockquote is inert', () => {
    const md = '[!important] at the start of a plain paragraph.';
    const [block] = parse(md);
    assert.equal(extractText(block.node), '[!important] at the start of a plain paragraph.');
  });

  it('only the blockquote-leading marker is flavor; a later [!x] in the same blockquote survives', () => {
    const md = ['> [!note] Title', '> see [!x] here too'].join('\n');
    const [block] = parse(md);
    assert.equal(extractText(block.node), 'Title\nsee [!x] here too');
  });

  it('task-list markers are dropped, item text is kept', () => {
    const md = ['- [ ] todo item', '- [x] done item'].join('\n');
    const [block] = parse(md);
    const text = extractText(block.node);
    assert.ok(!/\[[ x]\]/.test(text), 'checkbox markers must not survive');
    assert.equal(text, 'todo item\ndone item');
  });

  it('a link keeps its text and drops its URL', () => {
    const md = 'see [docs](https://x.com/a?b=c) for more';
    const [block] = parse(md);
    const text = extractText(block.node);
    assert.equal(text, 'see docs for more');
    assert.ok(!text.includes('x.com'), 'URL must not survive');
  });

  it('a piped wikilink resolves to its alias, a bare one to its target', () => {
    const md = 'see [[Target Note|alias text]] and [[Plain Target]]';
    const [block] = parse(md);
    assert.equal(extractText(block.node), 'see alias text and Plain Target');
  });

  it('a wikilink anchor keeps its text with the hash dropped, never "Page#Heading"', () => {
    const md = 'see [[Page#Heading]]';
    const [block] = parse(md);
    assert.equal(extractText(block.node), 'see Page Heading');
  });

  it('an alias still wins over an anchor when both are present', () => {
    const md = 'see [[Page#Heading|alias text]]';
    const [block] = parse(md);
    assert.equal(extractText(block.node), 'see alias text');
  });

  it('emphasis, strong and strikethrough markers are absent from the extracted text', () => {
    const md = 'some *italic* and **bold** and ~~strike~~ text';
    const [block] = parse(md);
    const text = extractText(block.node);
    assert.equal(text, 'some italic and bold and strike text');
    assert.ok(!/[*~]/.test(text));
  });
});

describe('extract: W0 fixture-driven fixes', () => {
  it('a paired %%comment%% is stripped, including the space around it', () => {
    const md = 'Visible text here. %%TODO: remove this before publishing%% more visible text.';
    const [block] = parse(md);
    assert.equal(extractText(block.node), 'Visible text here.  more visible text.');
  });

  it('an unpaired %% (printf-style escaped percent) is literal text and survives', () => {
    const md = 'In C printf, %% prints a literal percent sign.';
    const [block] = parse(md);
    assert.equal(extractText(block.node), md);
  });

  it('a %%comment%% pair spanning multiple lines of one paragraph is stripped', () => {
    const md = 'before %%hidden\ncomment\nspan%% after';
    const [block] = parse(md);
    assert.equal(extractText(block.node), 'before  after');
  });

  it('a trailing " ^id" is stripped at line end, but a caret mid-line is kept', () => {
    const md = ['- fact one ^anchor1', '- a caret ^ mid sentence stays'].join('\n');
    const [block] = parse(md);
    assert.equal(extractText(block.node), 'fact one\na caret ^ mid sentence stays');
  });

  it('an embed (![[..]]) resolves like a wikilink, anchor text kept, with the ! dropped', () => {
    const md = 'See ![[Target Note#Heading]] for details.';
    const [block] = parse(md);
    const text = extractText(block.node);
    assert.equal(text, 'See Target Note Heading for details.');
    assert.ok(!text.includes('!'), 'the embed bang must not survive');
  });

  it('an embed always yields its target, never a resize suffix after the pipe', () => {
    const md = 'See ![[photo.png|300]] for the image.';
    const [block] = parse(md);
    assert.equal(extractText(block.node), 'See photo.png for the image.');
  });

  it('a plain (non-embed) wikilink with a pipe still resolves to its alias, not the target', () => {
    const md = 'see [[Target Note|alias text]]';
    const [block] = parse(md);
    assert.equal(extractText(block.node), 'see alias text');
  });

  it('flavor constructs inside a code fence survive verbatim; the same constructs outside still resolve', () => {
    const md = ['```', 'a [[Target]] and a %%hidden%% span and text ^anchor1', '```', '', 'a [[Target]] and a %%hidden%% span and text ^anchor1'].join('\n');
    const [codeBlock, paragraph] = parse(md);
    assert.equal(extractText(codeBlock.node), 'a [[Target]] and a %%hidden%% span and text ^anchor1');
    assert.equal(extractText(paragraph.node), 'a Target and a  span and text');
  });

  it('flavor constructs inside inline code survive verbatim (backticks are delimiters, not part of the value)', () => {
    const md = 'see `[[Target]] %%x%% ^id` here';
    const [block] = parse(md);
    assert.equal(extractText(block.node), 'see [[Target]] %%x%% ^id here');
  });

  it('an HTML comment vanishes entirely; HTML tag content elsewhere is kept', () => {
    const md = ['<!-- hidden comment -->', '', '<mark>kept text</mark>', ''].join('\n');
    const blocks = parse(md);
    const texts = blocks.map((b) => extractText(b.node));
    assert.ok(!texts.some((t) => t.includes('hidden comment')), 'comment content must not survive');
    assert.ok(
      texts.some((t) => t === 'kept text'),
      'tag-wrapped content must survive with tags stripped'
    );
  });
});

describe('parse + extract: determinism', () => {
  it('parsing the same tricky document twice yields deep-equal results', () => {
    const md = ['# T', '', 'para with **bold** and [[a|b]]', '', '> [!note] hi', '> more', '', '| x | y |', '|---|---|', '| 1 | 2 |', '', '- [ ] a', '- [x] b', '', '[^1]: fn text'].join('\n');
    assert.deepStrictEqual(parse(md), parse(md));
    const texts1 = parse(md).map((b) => extractText(b.node));
    const texts2 = parse(md).map((b) => extractText(b.node));
    assert.deepStrictEqual(texts1, texts2);
  });
});
