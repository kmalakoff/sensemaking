import assert from 'node:assert';
import { extractText } from '../../../src/chunk/extract.ts';
import { parse } from '../../../src/chunk/parse.ts';
import type { Block } from '../../../src/chunk/types.ts';

// parse(): block typing and line extents come straight from markdown-it's token maps, never a
// regex guess. extractText(): plain text of one parsed block, structure kept, markup dropped.

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
    assert.match(extractText(blocks[1]), /# not-a-heading/);
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

describe('parse: parity classes from the 3.38 spike', () => {
  it("a list's endLine stops at its last item, not at the blank lines before the next block", () => {
    const md = ['- a', '- b', '', 'para after'].join('\n');
    const blocks = parse(md);
    assert.deepEqual(types(blocks), ['list', 'paragraph']);
    assert.deepEqual([blocks[0].startLine, blocks[0].endLine], [1, 2]);
    assert.deepEqual([blocks[1].startLine, blocks[1].endLine], [4, 4]);
  });

  it('a list followed by two blank lines trims both from its extent', () => {
    const md = ['- a', '- b', '', '', 'para after'].join('\n');
    const blocks = parse(md);
    assert.deepEqual([blocks[0].startLine, blocks[0].endLine], [1, 2]);
    assert.deepEqual([blocks[1].startLine, blocks[1].endLine], [5, 5]);
  });

  it('a list at end of file does not extend over the trailing blank lines', () => {
    const md = ['prose', '', '- x', '- y', '', ''].join('\n');
    const blocks = parse(md);
    assert.deepEqual([blocks[1].startLine, blocks[1].endLine], [3, 4]);
  });

  it('a heading with a wikilink resolves the link in its stored text', () => {
    const [block] = parse('# Anki [[Anki Deck]] review');
    assert.equal(block.text, 'Anki Anki Deck review');
  });

  it('a bare www. domain autolinks (fuzzyLink) and its display text contributes nothing', () => {
    const [block] = parse('See www.example.com here.');
    assert.equal(extractText(block), 'See  here.');
  });

  it('a bare email autolinks (fuzzyLink) and its display text contributes nothing', () => {
    const [block] = parse('Email foo@example.com please.');
    assert.equal(extractText(block), 'Email  please.');
  });

  it('a bare-domain fuzzy match is ordinary text, not an autolink (GFM links only http(s)/www./email)', () => {
    const [block] = parse('See Are.na here.');
    assert.equal(extractText(block), 'See Are.na here.');
  });

  it('an autolink swallows the closing quote and brace a GFM literal would span', () => {
    const [block] = parse('# {data-background-iframe="https://a.b/c"}');
    assert.equal(block.text, '{data-background-iframe="');
  });

  it('a trailing comma after an autolink stays text', () => {
    const [block] = parse('See https://a.b/c, and this.');
    assert.equal(extractText(block), 'See , and this.');
  });
});

// Where a linkify span and the old GFM autolink-literal machine disagree, the extracted text
// still lands where the old pipeline's did. Every expectation was pinned against the old
// mdast pipeline (pool-spike dist) before the swap.
describe('parse + extract: autolink boundary parity with the old pipeline', () => {
  it('a bracketed <https> leaf autolink is dropped whole, brackets included', () => {
    assert.equal(extractText(parse('See <https://a.b/c> here.')[0]), 'See  here.');
  });

  it('a bracketed <email> leaf autolink is dropped whole', () => {
    assert.equal(extractText(parse('Email: <a@b.co> y')[0]), 'Email:  y');
  });

  it('a bracketed <www> link keeps its literal brackets (the www text still drops)', () => {
    assert.equal(extractText(parse('at <www.patreon.com>.')[0]), 'at <>.');
  });

  it('an unbracketed trailing > after a www link stays text', () => {
    assert.equal(extractText(parse('at www.patreon.com>. b')[0]), 'at . b');
  });

  it('a ] after a url is re-emitted (the old trail ends before it, a [ mid-url does not)', () => {
    assert.equal(extractText(parse('x https://a.b/c[ref] z')[0]), 'x ] z');
    assert.equal(extractText(parse('x https://a.b/c[ref y')[0]), 'x  y');
  });

  it('a percent-encoded url still drops as a GFM autolink', () => {
    assert.equal(extractText(parse('See https://a.b/04+-+Guides%2C+Workflows here.')[0]), 'See  here.');
  });

  it('a user link whose label equals its url keeps the label (the old heuristic over-dropped it)', () => {
    assert.equal(extractText(parse('See [https://morss.it/](https://morss.it/) here.')[0]), 'See https://morss.it/ here.');
    assert.equal(extractText(parse('See [obsidian.garden](https://obsidian.garden) here.')[0]), 'See obsidian.garden here.');
  });

  it('a task item with no text contributes no line, so its softbreak drops', () => {
    const [list] = parse('- [ ] \n%%');
    assert.equal(extractText(list), '%%');
  });

  it('a first line whose only content is an autolink keeps its line ending', () => {
    assert.equal(extractText(parse('- ram@rachum.com\ntags:')[0]), '\ntags:');
    assert.equal(extractText(parse('![](a.png)\n![](b.png)')[0]), '\n');
  });

  it('balanced parens extend a url, an open paren runs the link on, a lone close re-emits', () => {
    assert.equal(extractText(parse('x https://a.b/c(y) z')[0]), 'x  z');
    assert.equal(extractText(parse('x https://a.b/c( y')[0]), 'x  y');
    assert.equal(extractText(parse('x https://a.b/c) z')[0]), 'x ) z');
  });

  it('a dot or comma after an email is not part of the domain, and re-emits', () => {
    assert.equal(extractText(parse('x a@b.co. y')[0]), 'x . y');
    assert.equal(extractText(parse('x a@b.co, y')[0]), 'x , y');
  });

  it('a quote followed by a word extends a url; a lone quote re-emits; a quote + brace extends', () => {
    assert.equal(extractText(parse('x https://a.b/c"b z')[0]), 'x  z');
    assert.equal(extractText(parse('x https://a.b/c" z')[0]), 'x " z');
    assert.equal(extractText(parse('x https://a.b/c"} z')[0]), 'x  z');
  });

  it('a bare & followed by a word extends a url (not a character reference)', () => {
    assert.equal(extractText(parse('x https://a.b/c&y z')[0]), 'x  z');
    assert.equal(extractText(parse('x https://a.b/c&amp z')[0]), 'x  z');
  });

  it('a non-GFM linkify target (ftp, protocol-relative) is not an autolink: its text is kept', () => {
    assert.equal(extractText(parse('x ftp://a.b/c y')[0]), 'x ftp://a.b/c y');
    assert.equal(extractText(parse('x //a.b/c y')[0]), 'x //a.b/c y');
  });
});

describe('extract: F8 regression cases', () => {
  it('a table extracts cell text row by row, without pipes or the delimiter row', () => {
    const md = ['| a | b |', '|---|---|', '| 1 | 2 |', '| 3 | 4 |'].join('\n');
    const [block] = parse(md);
    assert.equal(extractText(block), 'a b\n1 2\n3 4');
  });

  it('a footnote definition keeps its text', () => {
    const md = ['para', '', '[^1]: footnote body here'].join('\n');
    const blocks = parse(md);
    const def = blocks.find((b) => b.type === 'other');
    assert.ok(def, 'footnote definition should parse as a block');
    assert.equal(extractText(def as Block), 'footnote body here');
  });

  it('an Obsidian callout marker is dropped but the callout body is kept', () => {
    const md = ['> [!warning] Title', '> body text'].join('\n');
    const [block] = parse(md);
    const text = extractText(block);
    assert.ok(!text.includes('[!warning]'), 'marker must not survive');
    assert.equal(text, 'Title\nbody text');
  });

  it('a literal [!bracket] mid-sentence in a plain paragraph is inert, not a callout', () => {
    const md = 'Use [!important] sparingly in prose.';
    const [block] = parse(md);
    assert.equal(extractText(block), 'Use [!important] sparingly in prose.');
  });

  it('a plain paragraph starting with [!bracket] outside any blockquote is inert', () => {
    const md = '[!important] at the start of a plain paragraph.';
    const [block] = parse(md);
    assert.equal(extractText(block), '[!important] at the start of a plain paragraph.');
  });

  it('only the blockquote-leading marker is flavor; a later [!x] in the same blockquote survives', () => {
    const md = ['> [!note] Title', '> see [!x] here too'].join('\n');
    const [block] = parse(md);
    assert.equal(extractText(block), 'Title\nsee [!x] here too');
  });

  it('task-list markers are dropped, item text is kept', () => {
    const md = ['- [ ] todo item', '- [x] done item'].join('\n');
    const [block] = parse(md);
    const text = extractText(block);
    assert.ok(!/\[[ x]\]/.test(text), 'checkbox markers must not survive');
    assert.equal(text, 'todo item\ndone item');
  });

  it('a link keeps its text and drops its URL', () => {
    const md = 'see [docs](https://x.com/a?b=c) for more';
    const [block] = parse(md);
    const text = extractText(block);
    assert.equal(text, 'see docs for more');
    assert.ok(!text.includes('x.com'), 'URL must not survive');
  });

  it('a piped wikilink resolves to its alias, a bare one to its target', () => {
    const md = 'see [[Target Note|alias text]] and [[Plain Target]]';
    const [block] = parse(md);
    assert.equal(extractText(block), 'see alias text and Plain Target');
  });

  it('a wikilink anchor keeps its text with the hash dropped, never "Page#Heading"', () => {
    const md = 'see [[Page#Heading]]';
    const [block] = parse(md);
    assert.equal(extractText(block), 'see Page Heading');
  });

  it('an alias still wins over an anchor when both are present', () => {
    const md = 'see [[Page#Heading|alias text]]';
    const [block] = parse(md);
    assert.equal(extractText(block), 'see alias text');
  });

  it('emphasis, strong and strikethrough markers are absent from the extracted text', () => {
    const md = 'some *italic* and **bold** and ~~strike~~ text';
    const [block] = parse(md);
    const text = extractText(block);
    assert.equal(text, 'some italic and bold and strike text');
    assert.ok(!/[*~]/.test(text));
  });
});

describe('footnotes (parity with the old mdast pipeline)', () => {
  it('a referenced definition is its own other block, and the reference contributes nothing', () => {
    const md = ['text[^1] more', '', '[^1]: a footnote body'].join('\n');
    const blocks = parse(md);
    assert.deepEqual(types(blocks), ['paragraph', 'other']);
    assert.equal(extractText(blocks[0]), 'text more');
    assert.equal(extractText(blocks[1]), 'a footnote body');
    assert.deepEqual([blocks[1].startLine, blocks[1].endLine], [3, 3]);
  });

  it('a definition keeps its source position when it precedes its reference', () => {
    const md = ['[^2]: def first', '', 'body[^2]'].join('\n');
    const blocks = parse(md);
    assert.deepEqual(types(blocks), ['other', 'paragraph']);
    assert.equal(extractText(blocks[0]), 'def first');
    assert.deepEqual([blocks[0].startLine, blocks[0].endLine], [1, 1]);
  });

  it('a multi-paragraph definition joins its paragraphs one per line', () => {
    const md = ['x[^1]', '', '[^1]: first para', '', '    second para'].join('\n');
    const blocks = parse(md);
    const def = blocks.find((b) => b.type === 'other');
    assert.equal(extractText(def as Block), 'first para\nsecond para');
  });

  it('an inline ^[...] note is inert literal text (the old pipeline had no such syntax)', () => {
    const [block] = parse('see ^[inline note] here');
    assert.equal(extractText(block), 'see ^[inline note] here');
  });
});

describe('extract: W0 fixture-driven fixes', () => {
  it('a paired %%comment%% is stripped, including the space around it', () => {
    const md = 'Visible text here. %%TODO: remove this before publishing%% more visible text.';
    const [block] = parse(md);
    assert.equal(extractText(block), 'Visible text here.  more visible text.');
  });

  it('an unpaired %% (printf-style escaped percent) is literal text and survives', () => {
    const md = 'In C printf, %% prints a literal percent sign.';
    const [block] = parse(md);
    assert.equal(extractText(block), md);
  });

  it('a %%comment%% pair spanning multiple lines of one paragraph is stripped', () => {
    const md = 'before %%hidden\ncomment\nspan%% after';
    const [block] = parse(md);
    assert.equal(extractText(block), 'before  after');
  });

  it('a trailing " ^id" is stripped at line end, but a caret mid-line is kept', () => {
    const md = ['- fact one ^anchor1', '- a caret ^ mid sentence stays'].join('\n');
    const [block] = parse(md);
    assert.equal(extractText(block), 'fact one\na caret ^ mid sentence stays');
  });

  it('an embed (![[..]]) resolves like a wikilink, anchor text kept, with the ! dropped', () => {
    const md = 'See ![[Target Note#Heading]] for details.';
    const [block] = parse(md);
    const text = extractText(block);
    assert.equal(text, 'See Target Note Heading for details.');
    assert.ok(!text.includes('!'), 'the embed bang must not survive');
  });

  it('an embed always yields its target, never a resize suffix after the pipe', () => {
    const md = 'See ![[photo.png|300]] for the image.';
    const [block] = parse(md);
    assert.equal(extractText(block), 'See photo.png for the image.');
  });

  it('a plain (non-embed) wikilink with a pipe still resolves to its alias, not the target', () => {
    const md = 'see [[Target Note|alias text]]';
    const [block] = parse(md);
    assert.equal(extractText(block), 'see alias text');
  });

  it('flavor constructs inside a code fence survive verbatim; the same constructs outside still resolve', () => {
    const md = ['```', 'a [[Target]] and a %%hidden%% span and text ^anchor1', '```', '', 'a [[Target]] and a %%hidden%% span and text ^anchor1'].join('\n');
    const [codeBlock, paragraph] = parse(md);
    assert.equal(extractText(codeBlock), 'a [[Target]] and a %%hidden%% span and text ^anchor1');
    assert.equal(extractText(paragraph), 'a Target and a  span and text');
  });

  it('flavor constructs inside inline code survive verbatim (backticks are delimiters, not part of the value)', () => {
    const md = 'see `[[Target]] %%x%% ^id` here';
    const [block] = parse(md);
    assert.equal(extractText(block), 'see [[Target]] %%x%% ^id here');
  });

  it('an HTML comment vanishes entirely; HTML tag content elsewhere is kept', () => {
    const md = ['<!-- hidden comment -->', '', '<mark>kept text</mark>', ''].join('\n');
    const blocks = parse(md);
    const texts = blocks.map((b) => extractText(b));
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
    const texts1 = parse(md).map((b) => extractText(b));
    const texts2 = parse(md).map((b) => extractText(b));
    assert.deepStrictEqual(texts1, texts2);
  });
});
