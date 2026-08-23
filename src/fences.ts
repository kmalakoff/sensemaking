// Shared line-fence tracker for tags/sections/embed. Opener: >=3 backticks or tildes at column
// 0 -- no indent allowance, a deliberate divergence from CommonMark's up-to-3-space rule (see
// test/unit/fences.test.ts DIVERGENCES table). A backtick opener's info string must not itself
// contain a backtick (spec rule). A closer is a run of the SAME character, length >= the
// opener's, holding nothing but trailing spaces after the run.

export interface FenceTracker {
  feed(line: string): boolean; // true iff this line is a fence delimiter (open or close)
  readonly inFence: boolean;
}

const BACKTICK_OPEN = /^(`{3,})(.*)$/;
const TILDE_OPEN = /^(~{3,})(.*)$/;

export function fenceTracker(): FenceTracker {
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  return {
    feed(line: string): boolean {
      if (!inFence) {
        const bt = BACKTICK_OPEN.exec(line);
        if (bt && !bt[2].includes('`')) {
          inFence = true;
          fenceChar = '`';
          fenceLen = bt[1].length;
          return true;
        }
        const td = TILDE_OPEN.exec(line);
        if (td) {
          inFence = true;
          fenceChar = '~';
          fenceLen = td[1].length;
          return true;
        }
        return false;
      }
      const run = fenceChar === '`' ? /^(`+)(.*)$/ : /^(~+)(.*)$/;
      const m = run.exec(line);
      if (m && m[1].length >= fenceLen && m[2].trim() === '') {
        inFence = false;
        return true;
      }
      return false;
    },
    get inFence() {
      return inFence;
    },
  };
}

// Masks <!-- ... --> spans that may cross line boundaries, one line at a time so callers can
// interleave it with their own per-line state. In isolation an unclosed <!-- stays open forever
// (mask() has no notion of a line boundary that should kill it); maskRegions() below is what
// calls close() at the point an unclosed comment actually dies -- a blank line at paragraph
// level, or its enclosing HTML block's end.
export interface CommentTracker {
  mask(line: string): string;
  close(): void; // force-ends an unclosed comment (paragraph blank line, or its HTML block ending)
  readonly inComment: boolean;
}

export function commentTracker(): CommentTracker {
  let inComment = false;
  return {
    mask(line: string): string {
      let out = '';
      let i = 0;
      while (i < line.length) {
        if (inComment) {
          const end = line.indexOf('-->', i);
          if (end === -1) {
            out += ' '.repeat(line.length - i);
            i = line.length;
          } else {
            out += ' '.repeat(end + 3 - i);
            i = end + 3;
            inComment = false;
          }
          continue;
        }
        const start = line.indexOf('<!--', i);
        if (start === -1) {
          out += line.slice(i);
          i = line.length;
        } else {
          out += `${line.slice(i, start)}    `;
          i = start + 4;
          inComment = true;
        }
      }
      return out;
    },
    close() {
      inComment = false;
    },
    get inComment() {
      return inComment;
    },
  };
}

// CommonMark's HTML-block type-6 list (fixed by the spec, not a drifting enumeration): a line
// starting with an open or close tag of one of these, at column 0 (leading whitespace/`>`
// blockquote markers tolerated), opens a block that swallows following lines -- tags, links,
// and comments alike -- until a blank line closes it.
const HTML_BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'base',
  'basefont',
  'blockquote',
  'body',
  'caption',
  'center',
  'col',
  'colgroup',
  'dd',
  'details',
  'dialog',
  'dir',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'frame',
  'frameset',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'header',
  'hr',
  'html',
  'iframe',
  'legend',
  'li',
  'link',
  'main',
  'menu',
  'menuitem',
  'nav',
  'noframes',
  'ol',
  'optgroup',
  'option',
  'p',
  'param',
  'search',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'title',
  'tr',
  'track',
  'ul',
]);
// Type-1 blocks (script/pre/style/textarea): closes on the line holding the matching end tag,
// not on a blank line, and that line is the last one swallowed.
const HTML_PRE_TAGS = new Set(['script', 'pre', 'style', 'textarea']);
const HTML_PRE_CLOSE_RE = /<\/(?:script|pre|style|textarea)>/i; // any of the four closers ends the block, not only the tag that opened it
// An opening or closing tag at column 0, tag name captured for the lookups above.
const HTML_BLOCK_OPEN_RE = /^<\/?([a-zA-Z][a-zA-Z0-9]*)(?:[ \t]|\/?>|$)/;
const BLANK_LINE_RE = /^[ \t>]*$/; // whitespace/blockquote-markers only -- a paragraph break, and what ends a type-6 block

// Body with fenced-code, HTML-block, and <!-- --> comment regions replaced by spaces (newlines
// preserved, so line numbers and offsets survive) plus inline code spans masked. The single
// region masker for tags/links: fence and HTML-block delimiter+content lines are opaque, an
// unclosed comment dies at its containing block's end (or the next blank line at paragraph
// level -- never silently to end of file), and a closed comment masks exactly its span.
// Bodies without a backtick/tilde/`<` fast-path out untouched.
export function maskRegions(body: string): string {
  if (!/[`~<]/.test(body)) return body;
  const fence = fenceTracker();
  const comment = commentTracker();
  let inHtmlBlock = false;
  let htmlBlockClose: RegExp | null = null; // set while inside a type-1 (script/pre/style/textarea) block
  return body
    .split('\n')
    .map((line) => {
      if (inHtmlBlock) {
        if (htmlBlockClose) {
          if (htmlBlockClose.test(line)) {
            inHtmlBlock = false;
            htmlBlockClose = null;
          }
          return ' '.repeat(line.length);
        }
        if (BLANK_LINE_RE.test(line)) {
          // Block content never feeds the comment tracker, so an inner <!-- was only ever
          // masked text; nothing to close here.
          inHtmlBlock = false;
          return line;
        }
        return ' '.repeat(line.length);
      }
      if (!comment.inComment) {
        const isDelim = fence.feed(line);
        if (isDelim || fence.inFence) return ' '.repeat(line.length);
      }
      const uncommented = comment.inComment || line.includes('<!--') ? comment.mask(line) : line;
      if (comment.inComment && BLANK_LINE_RE.test(line)) comment.close(); // paragraph-level: dies at the next blank line
      // Indented or blockquoted HTML blocks still swallow their content in Obsidian, so the
      // opener test runs after stripping leading whitespace and > markers.
      const stripped = uncommented.replace(/^[ \t>]*/, '');
      if (stripped[0] === '<') {
        const openMatch = HTML_BLOCK_OPEN_RE.exec(stripped);
        if (openMatch) {
          const tagName = openMatch[1].toLowerCase();
          const isClosingTag = stripped[1] === '/';
          if (!isClosingTag && HTML_PRE_TAGS.has(tagName)) {
            // The end condition can be met on the opening line itself: <script>x</script>
            // is a one-line block and the next line parses (Obsidian-verified).
            if (!HTML_PRE_CLOSE_RE.test(stripped.slice(openMatch[0].length))) {
              inHtmlBlock = true;
              htmlBlockClose = HTML_PRE_CLOSE_RE;
            }
            return ' '.repeat(line.length);
          }
          if (HTML_BLOCK_TAGS.has(tagName)) {
            inHtmlBlock = true;
            return ' '.repeat(line.length);
          }
        }
      }
      // Inline code spans hide their content too: `[[x]]` in prose is not a link.
      return uncommented.includes('`') ? maskCodeSpans(uncommented) : uncommented;
    })
    .join('\n');
}

// A code span opens on a run of N backticks and closes at the next run of exactly N -- a
// shorter or longer run in between is literal text, not a delimiter (CommonMark code spans).
// Masked with spaces so column positions and tag-boundary whitespace are unaffected.
export function maskCodeSpans(line: string): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '`') {
      out += line[i];
      i++;
      continue;
    }
    let j = i;
    while (line[j] === '`') j++;
    const n = j - i;
    let k = j;
    let closeStart = -1;
    let closeEnd = -1;
    while (k < line.length) {
      if (line[k] !== '`') {
        k++;
        continue;
      }
      let m = k;
      while (line[m] === '`') m++;
      if (m - k === n) {
        closeStart = k;
        closeEnd = m;
        break;
      }
      k = m;
    }
    if (closeStart >= 0) {
      out += ' '.repeat(closeEnd - i);
      i = closeEnd;
    } else {
      out += line.slice(i, j);
      i = j;
    }
  }
  return out;
}
