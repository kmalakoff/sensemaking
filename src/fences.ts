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
