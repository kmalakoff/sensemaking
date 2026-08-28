import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fenceTracker } from '../../../src/features/fences.ts';

// fenceTracker against every CommonMark "Fenced code blocks" example. For each, we derive the
// spec's fence content from the html (the text inside <pre><code>) and compare it against what
// feeding the markdown's lines through the tracker produces.

interface FixtureCase {
  markdown: string;
  html: string;
  example: number;
  section: string;
}

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'commonmark-fences.json');
const fixtures: FixtureCase[] = JSON.parse(readFileSync(fixturePath, 'utf8'));
const fenced = fixtures.filter((f) => f.section === 'Fenced code blocks');

function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

// Spec content is the text between the first <pre><code...> and its </code></pre>; absent
// entirely, the markdown holds no fenced block at all.
function specContent(html: string): string {
  const m = /<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/.exec(html);
  return m ? unescapeHtml(m[1]) : '';
}

// Lines the tracker considers fence content: not themselves a delimiter, fed while inFence.
function trackerContent(markdown: string): string {
  const lines = markdown.split('\n');
  if (lines[lines.length - 1] === '') lines.pop(); // trailing newline's empty split artifact
  const fence = fenceTracker();
  let out = '';
  for (const line of lines) {
    const isDelim = fence.feed(line);
    if (!isDelim && fence.inFence) out += `${line}\n`;
  }
  return out;
}

// DIVERGENCES: examples where our column-0, no-indent, single-fence-per-file-position model
// disagrees with the CommonMark spec's content, and exactly what the tracker does instead.
// Each `got` is a hard-coded snapshot of trackerContent(markdown) -- a behavior change here
// must edit this table, not silently pass.
const DIVERGENCES: Record<number, { reason: string; got: string }> = {
  // Fence markers need blockquote-marker awareness ("> ```") that a column-0 check can't give;
  // the whole thing reads as ordinary non-fence text, so no fence opens at all.
  128: { reason: 'a fence inside a blockquote ("> ```") is not recognized; no fence opens', got: '' },
  // Opener indented 1 space is not column 0, so it is not recognized; the trailing column-0
  // "```" (the spec's closer) is then read, wrongly, as a fresh unterminated opener.
  131: { reason: 'a 1-space-indented opener is not recognized; a later column-0 "```" opens instead', got: '' },
  // Opener and closer both indented 2 spaces: neither is column 0, so no fence is ever seen.
  132: { reason: 'opener and closer indented 2 spaces are both unrecognized; no fence opens', got: '' },
  // Same, at the spec's maximum allowed indent (3 spaces).
  133: { reason: 'opener and closer indented 3 spaces (spec max) are both unrecognized; no fence opens', got: '' },
  // 4-space indent makes this an indented code block per spec (backticks are literal text, not
  // fence markers). Our tracker never opens a fence here either, but only because column 0 does
  // not match -- it does not know about indented code blocks at all.
  134: { reason: 'indented code block (4 spaces): not a fence either way, but for an unrelated reason -- no indented-code-block handling', got: '' },
  // Closer indented 2 spaces is not recognized as a closer, so the fence never closes.
  135: { reason: 'a 2-space-indented closer is not recognized; the fence stays open through EOF', got: 'aaa\n  ```\n' },
  // Opener indented 3 spaces is not recognized, so no fence opens at all.
  136: { reason: 'a 3-space-indented opener is not recognized; no fence opens', got: '' },
};

describe('fenceTracker: CommonMark "Fenced code blocks" conformance', () => {
  let conformant = 0;
  const divergent = Object.keys(DIVERGENCES).length;

  for (const f of fenced) {
    const isDivergence = f.example in DIVERGENCES;
    it(`example ${f.example}${isDivergence ? ' (divergence)' : ''}: ${JSON.stringify(f.markdown)}`, () => {
      const got = trackerContent(f.markdown);
      if (isDivergence) {
        assert.equal(got, DIVERGENCES[f.example].got, DIVERGENCES[f.example].reason);
      } else {
        assert.equal(got, specContent(f.html), 'tracker content should match the spec fence content');
        conformant++;
      }
    });
  }

  after(() => {
    assert.equal(conformant, fenced.length - divergent, 'conformant + divergent should account for every example');
  });
});
