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
// interleave it with their own per-line state. An unclosed <!-- masks to end of input, matching
// CommonMark type-2 HTML comments' practical effect (everything after is swallowed).
export interface CommentTracker {
  mask(line: string): string;
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
    get inComment() {
      return inComment;
    },
  };
}

// Body with fenced-code regions (delimiter and content lines) and <!-- --> comment spans
// replaced by spaces, newlines preserved so line numbers and offsets survive. Bodies without a
// backtick/tilde/`<!--` fast-path out untouched.
export function maskRegions(body: string): string {
  if (!/[`~]/.test(body) && !body.includes('<!--')) return body;
  const fence = fenceTracker();
  const comment = commentTracker();
  return body
    .split('\n')
    .map((line) => {
      if (!comment.inComment) {
        const isDelim = fence.feed(line);
        if (isDelim || fence.inFence) return ' '.repeat(line.length);
      }
      const uncommented = comment.mask(line);
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
