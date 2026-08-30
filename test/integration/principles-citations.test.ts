import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import cr from 'cr';
import { packageRoot } from '../lib/scratch.ts';

// PRINCIPLES.md is cited by name, not number, so a stale name is detectable: it resolves to no
// heading here and this check catches it, where a stale number would resolve to the wrong
// principle silently. The planning directory cites by the old numbers deliberately and is
// never scanned, which is why the scan below is scoped to src and test.

const normalize = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');

function levenshtein(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) d[i][0] = i;
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = a[i - 1] === b[j - 1] ? d[i - 1][j - 1] : 1 + Math.min(d[i - 1][j - 1], d[i - 1][j], d[i][j - 1]);
  return d[a.length][b.length];
}

describe('PRINCIPLES.md citations', () => {
  it('every principle citation in src/ and test/ names a real heading', () => {
    const doc = cr(readFileSync(join(packageRoot, 'PRINCIPLES.md'), 'utf8'));
    const valid = new Set([...doc.matchAll(/^##\s+(.+)$/gm)].map((m) => normalize(m[1])));
    assert.ok(valid.size > 0, 'no headings found in PRINCIPLES.md');

    // --others --exclude-standard so a not-yet-committed file is scanned too: a new file is
    // where a wrong name actually gets introduced, and tracked-only would pass it silently.
    const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', 'src', 'test'], { cwd: packageRoot, encoding: 'utf8' })
      .split('\0')
      .filter((f) => /\.(ts|js|mjs|cjs)$/.test(f));

    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(join(packageRoot, file), 'utf8');
      // The gap tolerates a citation wrapped across a comment line break, where a `//` sits
      // between the prefix and the name.
      for (const m of text.matchAll(/\(PRINCIPLES:[\s/]*([\w-]+)\)/g)) {
        const name = m[1];
        if (valid.has(name)) continue;
        const closest = [...valid].sort((a, b) => levenshtein(name, a) - levenshtein(name, b))[0];
        offenders.push(`${file}: "${name}" is not a PRINCIPLES.md heading (closest: ${closest})`);
      }
    }
    assert.deepEqual(offenders, []);
  });
});
