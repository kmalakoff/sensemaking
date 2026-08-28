import assert from 'node:assert';
import { estimateTokens } from '../../../src/chunk/group.ts';
import { chunk, chunkFromBlocks } from '../../../src/chunk/index.ts';
import { parse } from '../../../src/chunk/parse.ts';
import type { Chunk } from '../../../src/chunk/types.ts';

// chunk(body, opts): W2's public entry. group.ts implements D1 (heading scope), pgc pairing (D3),
// and the rule-5 oversize fallback; this suite pins the grouping policy the way parse.test.ts pins parse+extract.

function extents(chunks: Chunk[]): [number, number][] {
  return chunks.map((c) => [c.startLine, c.endLine]);
}

function lines(body: string): string[] {
  return body.split('\n');
}

describe('group: pgc grouping', () => {
  it('5 paragraphs under one heading group as [heading+p1+p2], [p3+p4], [p5]', () => {
    const md = ['# H', '', 'p1', '', 'p2', '', 'p3', '', 'p4', '', 'p5'].join('\n');
    const chunks = chunk(md, { text: 'extracted' });
    assert.deepStrictEqual(
      chunks.map((c) => c.text),
      ['H\np1\np2', 'p3\np4', 'p5']
    );
    assert.deepStrictEqual(extents(chunks), [
      [1, 5],
      [7, 9],
      [11, 11],
    ]);
  });

  it("a heading never starts an orphaned chunk: every heading opens its scope's first group", () => {
    const md = ['# One', '', 'p1', '', '## Two', '', 'p2', '', 'p3'].join('\n');
    const chunks = chunk(md, { text: 'extracted' });
    assert.ok(chunks[0].text.startsWith('One'));
    assert.ok(
      chunks.some((c) => c.text.startsWith('Two')),
      'the second heading also opens a group rather than standing alone'
    );
    assert.ok(
      chunks.every((c) => c.text.split('\n').length > 1 || !/^(One|Two)$/.test(c.text)),
      'no chunk is a heading by itself'
    );
  });

  it('a table straddling a would-be paragraph boundary is never split: it joins one group whole', () => {
    const md = ['# H', '', 'p1', '', '| a | b |', '|---|---|', '| 1 | 2 |', '', 'p2', '', 'p3'].join('\n');
    const chunks = chunk(md, { text: 'extracted' });
    assert.deepStrictEqual(
      chunks.map((c) => c.text),
      ['H\np1\na b\n1 2', 'p2\np3']
    );
    // The table's own two rows are contiguous inside one chunk, never divided across two.
    assert.ok(chunks[0].text.includes('a b\n1 2'));
  });
});

describe('group: text option (D9 raw baseline, W3)', () => {
  it("text: 'extracted' is flavor-resolved; 'raw' (the default) is the chunk's own source lines verbatim", () => {
    const md = ['# H', '', 'a **bold** word and a [link](http://x).'].join('\n');
    const extracted = chunk(md, { text: 'extracted' });
    const raw = chunk(md);
    assert.deepStrictEqual(extents(extracted), extents(raw));
    assert.ok(!extracted[0].text.includes('**'), extracted[0].text);
    assert.ok(raw[0].text.includes('**bold**'), raw[0].text);
    assert.ok(raw[0].text.includes('(http://x)'), raw[0].text);
  });

  it("'raw' text is exactly the source lines of the chunk's extent, joined and trimmed", () => {
    const md = ['# H', '', 'p1', '', 'p2', '', 'p3'].join('\n');
    const bodyLines = lines(md);
    for (const c of chunk(md, { text: 'raw' })) {
      assert.strictEqual(
        c.text,
        bodyLines
          .slice(c.startLine - 1, c.endLine)
          .join('\n')
          .trim()
      );
    }
  });
});

describe('group: CJK metric (D5)', () => {
  it("estimateTokens counts dense-script graphemes (segment.ts's unspaced-script set, plus Hangul) 1:1, spaced text at ~4 chars/token", () => {
    assert.strictEqual(estimateTokens('中'.repeat(10)), 10);
    assert.strictEqual(estimateTokens('a'.repeat(40)), 10);
    // Thai: one of segment.ts's unspaced scripts, not "CJK" by name but dense the same way.
    assert.strictEqual(estimateTokens('ก'.repeat(10)), 10);
  });
});

describe('group: oversize fallback (rule 5)', () => {
  it('a single block over 2x working size splits at line boundaries, every piece <= working size, extents exact and contiguous', () => {
    const body = Array.from({ length: 20 }, () => 'word word word word word word word word').join('\n');
    const bodyLines = lines(body);
    const targetTokens = 50;
    const chunks = chunk(body, { targetTokens });
    // Every piece stays at or under working size -- the truncation case (F3) this rule exists to close.
    for (const c of chunks) assert.ok(estimateTokens(c.text) <= targetTokens, `chunk ${c.startLine}-${c.endLine} exceeds working size`);
    // Pieces are contiguous and exact: first chunk starts at the body's first line, last ends at
    // its last line, and each subsequent piece starts exactly where the previous one ended.
    assert.strictEqual(chunks[0].startLine, 1);
    assert.strictEqual(chunks[chunks.length - 1].endLine, bodyLines.length);
    for (let i = 1; i < chunks.length; i++) assert.strictEqual(chunks[i].startLine, chunks[i - 1].endLine + 1);
  });

  it('under pgc, a single paragraph over 2x the default working size (1000 tokens) is also split, every piece <= 500', () => {
    const body = Array.from({ length: 30 }, () => '中'.repeat(100)).join('\n'); // 3000 dense-script tokens total
    const chunks = chunk(body);
    assert.ok(chunks.length > 1, 'one oversize paragraph must split into more than one chunk');
    for (const c of chunks) assert.ok(estimateTokens(c.text) <= 500);
  });

  it('a single heading over 2x working size splits like any other oversize block, every piece <= working size', () => {
    const targetTokens = 50;
    const headingLine = `# ${'word '.repeat(2000).trim()}`; // ~2500 estimated tokens, well over 2x working
    const chunks = chunk(headingLine, { targetTokens, text: 'extracted' });
    assert.ok(chunks.length > 1, 'one oversize heading must still split into more than one chunk');
    for (const c of chunks) assert.ok(estimateTokens(c.text) <= targetTokens, `chunk ${c.startLine}-${c.endLine} exceeds working size`);
  });

  // In raw mode (the shipped default), each sub-line-split piece carries its own slice of the
  // source line, not a duplicate of the whole line re-sliced by group()'s raw pass.
  it('a single heading over 2x working size splits in raw mode too, each piece its own slice of the line', () => {
    const targetTokens = 50;
    // Indexed, not repeated: a uniformly repeated word can legitimately produce byte-identical
    // pieces at different offsets, which would defeat the distinctness check below for reasons
    // unrelated to the bug it exists to catch.
    const headingLine = `# ${Array.from({ length: 2000 }, (_, i) => `word${i}`).join(' ')}`;
    const chunks = chunk(headingLine, { targetTokens }); // raw is the default
    assert.ok(chunks.length > 1, 'one oversize heading must still split into more than one chunk');
    const texts = chunks.map((c) => c.text);
    for (const c of chunks) {
      assert.ok(estimateTokens(c.text) <= targetTokens, `chunk ${c.startLine}-${c.endLine} exceeds working size`);
      assert.strictEqual(c.startLine, 1);
      assert.strictEqual(c.endLine, 1);
    }
    assert.strictEqual(new Set(texts).size, texts.length, 'every piece must carry its own slice, not a duplicate of the whole raw line');
    assert.strictEqual(texts.join(''), headingLine, 'pieces must tile the raw line exactly, losing nothing');
  });

  for (const textMode of ['raw', 'extracted'] as const) {
    it(`an atomic block between 1x and 2x working size is never split, and no chunk ever exceeds 2x working size (text: ${textMode})`, () => {
      const targetTokens = 100;
      const working = targetTokens;
      // Markdown-syntax-heavy: raw carries bold/emphasis/link/code markup extractText strips
      // away, so raw and extracted sizing genuinely diverge per line (not just in byte count).
      const huge = Array.from({ length: 50 }, () => '**word** *word* [word](http://example.com/word) `word` word word word').join('\n');
      const tableCell = 'w'.repeat(1.5 * working * 4); // one table row, ~1.5x working estimated tokens
      const md = ['# H', '', huge, '', `| ${tableCell} |`, '|---|', '| x |', '', 'a short paragraph', '', 'another short one'].join('\n');
      const chunks = chunk(md, { targetTokens, text: textMode });

      for (const c of chunks) assert.ok(estimateTokens(c.text) <= 2 * working, `chunk ${c.startLine}-${c.endLine} exceeds 2x working size (${textMode})`);

      // The table's own text (its filler cell) survives whole in exactly one chunk -- proof it was
      // never split, even though it sits well above working size on its own.
      const tableChunks = chunks.filter((c) => c.text.includes(tableCell));
      assert.strictEqual(tableChunks.length, 1);
    });
  }

  it('raw mode sizes a pgc pair by its raw text, not the flavor-resolved extract (link-heavy paragraphs)', () => {
    // Each link's raw form (long URL) is bulky; its extracted form is just the one-word label,
    // so a pair whose extracted size looks small can still be oversize once raw text ships.
    const link = (i: number) => `[t${i}](http://example.com/${'a'.repeat(60)})`;
    const para = Array.from({ length: 36 }, (_, i) => link(i)).join(' ');
    const md = ['# H', '', para, '', para].join('\n');
    const chunks = chunk(md); // raw is the default

    assert.ok(chunks.length > 1, 'a link-heavy pair must not merge into one oversize raw chunk');
    for (const c of chunks) assert.ok(estimateTokens(c.text) <= 1000, `chunk ${c.startLine}-${c.endLine} exceeds 2x the default working size (raw text: ${c.text.length} chars)`);
  });

  it('an oversize table splits into pieces that all keep pipe syntax (raw slices, no per-piece re-parse)', () => {
    const targetTokens = 30;
    const rows = Array.from({ length: 40 }, (_, i) => `| row${i} | ${'w'.repeat(20)} |`);
    const md = ['| a | b |', '|---|---|', ...rows].join('\n');
    const chunks = chunk(md, { targetTokens });
    assert.ok(chunks.length > 1, 'the table must split into more than one piece');
    for (const c of chunks) {
      assert.ok(estimateTokens(c.text) <= targetTokens, `chunk ${c.startLine}-${c.endLine} exceeds working size`);
      assert.ok(c.text.includes('|'), `piece lost pipe syntax: ${JSON.stringify(c.text)}`);
    }
  });

  it('pgc pairing that would cross 2x working size closes at one paragraph instead of pairing (coordinator case A)', () => {
    const para = 'w'.repeat(790 * 4); // ~790 estimated tokens: under the 1000 single-block trigger alone
    const md = ['# H', '', para, '', para].join('\n');
    const chunks = chunk(md);
    assert.strictEqual(chunks.length, 2, 'the pair must not merge into one over-cap chunk');
    for (const c of chunks) assert.ok(estimateTokens(c.text) <= 1000, `chunk ${c.startLine}-${c.endLine} exceeds 2x the default working size`);
  });

  it('a single-line paragraph over working size splits at word boundaries (no sentence punctuation to key on); extents stay on that line', () => {
    const body = Array.from({ length: 1300 }, () => 'word').join(' ');
    const chunks = chunk(body, { targetTokens: 500, text: 'extracted' });
    assert.ok(chunks.length > 1, 'one unbreakable line must still split into more than one chunk');
    for (const c of chunks) {
      assert.ok(estimateTokens(c.text) <= 500, `piece ${JSON.stringify(c.text.slice(0, 20))}... exceeds working size`);
      assert.strictEqual(c.startLine, 1);
      assert.strictEqual(c.endLine, 1);
    }
  });

  it('a single-line paragraph over working size splits at word boundaries in raw mode too, every piece distinct and covering the line', () => {
    // Indexed, not repeated: see the heading test above for why.
    const body = Array.from({ length: 1300 }, (_, i) => `word${i}`).join(' ');
    const chunks = chunk(body, { targetTokens: 500 }); // raw is the default
    assert.ok(chunks.length > 1, 'one unbreakable line must still split into more than one chunk');
    const texts = chunks.map((c) => c.text);
    for (const c of chunks) {
      assert.ok(estimateTokens(c.text) <= 500, `piece ${JSON.stringify(c.text.slice(0, 20))}... exceeds working size`);
      assert.strictEqual(c.startLine, 1);
      assert.strictEqual(c.endLine, 1);
    }
    assert.strictEqual(new Set(texts).size, texts.length, 'every piece must carry its own slice, not a duplicate of the whole raw line');
    assert.strictEqual(texts.join(''), body, 'pieces must tile the raw line exactly, losing nothing');
  });

  it('a Chinese single-line paragraph splits at sentence boundaries, never mid-sentence', () => {
    const sentence = '今天天气很好。';
    let body = '';
    while (estimateTokens(body) < 1200) body += sentence;
    const chunks = chunk(body, { text: 'extracted' });
    assert.ok(chunks.length > 1, 'one long unbroken line must still split into more than one chunk');
    for (const c of chunks) assert.ok(estimateTokens(c.text) <= 500, `piece exceeds working size: ${c.text.length} chars`);
    for (let i = 0; i < chunks.length - 1; i++) assert.ok(chunks[i].text.endsWith('。'), `non-final piece ${i} does not end on a sentence boundary`);
    for (const c of chunks) assert.strictEqual(c.startLine, 1);
  });

  it('a Chinese single-line paragraph splits at sentence boundaries in raw mode too, every piece distinct and covering the line', () => {
    // Indexed, not repeated: an identical sentence repeated verbatim can legitimately produce
    // byte-identical pieces at different offsets, which would defeat the distinctness check
    // below for reasons unrelated to the bug it exists to catch. The index (ASCII digits) does
    // not change the sentence's dense-script density or its '。' terminator.
    let body = '';
    let i = 0;
    while (estimateTokens(body) < 1200) {
      body += `今天天气很好${i}。`;
      i++;
    }
    const chunks = chunk(body); // raw is the default
    assert.ok(chunks.length > 1, 'one long unbroken line must still split into more than one chunk');
    const texts = chunks.map((c) => c.text);
    for (const c of chunks) assert.ok(estimateTokens(c.text) <= 500, `piece exceeds working size: ${c.text.length} chars`);
    for (let i = 0; i < chunks.length - 1; i++) assert.ok(chunks[i].text.endsWith('。'), `non-final piece ${i} does not end on a sentence boundary`);
    for (const c of chunks) assert.strictEqual(c.startLine, 1);
    assert.strictEqual(new Set(texts).size, texts.length, 'every piece must carry its own slice, not a duplicate of the whole raw line');
    assert.strictEqual(texts.join(''), body, 'pieces must tile the raw line exactly, losing nothing');
  });
});

describe('group: empty and degenerate bodies', () => {
  it('an empty body yields no chunks', () => {
    assert.deepStrictEqual(chunk(''), []);
  });

  it('a blank, frontmatter-only-shaped body yields no chunks', () => {
    assert.deepStrictEqual(chunk('   \n\n  \n'), []);
  });

  it('a headings-only body yields one chunk per heading, never crashing or merging across scopes', () => {
    const md = ['# One', '', '## Two', '', '### Three'].join('\n');
    const chunks = chunk(md, { text: 'extracted' });
    assert.deepStrictEqual(
      chunks.map((c) => c.text),
      ['One', 'Two', 'Three']
    );
  });
});

describe('group: determinism (F5)', () => {
  it('the same body and options produce deep-equal results across calls', () => {
    const md = ['# H', '', 'p1', '', 'p2', '', 'p3', '', '中'.repeat(20)].join('\n');
    const opts = { targetTokens: 12 };
    assert.deepStrictEqual(chunk(md, opts), chunk(md, opts));
    assert.deepStrictEqual(chunk(md), chunk(md));
  });

  it('chunk(body) matches chunkFromBlocks(parse(body), body): the shared-parse path is a pure delegate', () => {
    const md = ['# H', '', 'a **bold** word and a [link](http://x).', '', 'p2'].join('\n');
    const opts = { targetTokens: 30 };
    assert.deepStrictEqual(chunk(md, opts), chunkFromBlocks(parse(md), md, opts));
    assert.deepStrictEqual(chunk(md), chunkFromBlocks(parse(md), md));
  });
});

describe('group: line-extent integrity', () => {
  it("every chunk's extent maps back to real, non-blank body lines", () => {
    const md = ['# H', '', 'p1', '', 'p2', '', '| a | b |', '|---|---|', '| 1 | 2 |', '', 'p3'].join('\n');
    const bodyLines = lines(md);
    for (const c of chunk(md)) {
      assert.ok(c.startLine >= 1 && c.startLine <= bodyLines.length);
      assert.ok(c.endLine >= 1 && c.endLine <= bodyLines.length);
      assert.ok(bodyLines[c.startLine - 1].trim().length > 0, `chunk start line ${c.startLine} is blank`);
      assert.ok(bodyLines[c.endLine - 1].trim().length > 0, `chunk end line ${c.endLine} is blank`);
    }
  });
});
