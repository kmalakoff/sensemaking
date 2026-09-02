// Maps paths changed since the last tag to the gates they owe, per the release-gate diff-map
// table. A gate the map owes is never skippable by a flag; the only way to not run it is
// to change this file, which is a reviewed diff.
//
// Rows 1-6 are the diff-map table, verified 2026-09-01 against each gate script's own
// imports (test:engines: src/store/sqlite/connection.ts imports node:sqlite, src/watch.ts imports
// node:fs's watch, src/scan/pool.ts and src/workers/parse.ts run through tinypool -- all
// Node-version-sensitive; live suite: test/integration/live.test.ts imports src/embed/* directly;
// store-dump: dumps tables gated by src/features/* and the embeddings table depends on src/chunk/*
// chunking; oracle: imports src/chunk/index.js's parse() and src/scan/frontmatter.js's
// splitFrontmatter, and diffs tags/links against src/features/tags.ts and links.ts, with sections
// depending on src/features/sections.ts and fences.ts, which both tags and sections share;
// scale/stress: src/scan/pool.ts and reparse.ts drive crawl throughput, src/graph/* feeds the
// map/related/rank commands run.mjs times; fever: src/commands/search.ts is the ranking entry
// point, and src/scan/frontmatter.ts duplicates title/summary into content so bm25() can weight
// them, per its own comment).
//
// Rows 7-8 (baseline, quality-baseline) are not from that table -- they are the pipeline table's
// stage-level "owed when" columns for stage 2 (compare + hub battery) and stage 4's nfcorpus leg,
// which are broader than any single diff-map row. They live here anyway because release.mjs needs
// one function answering "what does this diff owe", not two.
const DIFF_MAP = [
  { gate: 'test-engines', when: ['src/store/sqlite/', 'src/watch.ts', 'src/scan/', 'src/workers/', 'package.json'] },
  { gate: 'live-suite', when: ['src/embed/'] },
  { gate: 'store-dump', when: ['src/store/', 'src/chunk/', 'src/features/'] },
  { gate: 'oracle', when: ['src/chunk/', 'src/text/', 'src/scan/frontmatter.ts', 'src/features/tags.ts', 'src/features/links.ts', 'src/features/sections.ts', 'src/features/fences.ts'] },
  { gate: 'scale', when: ['src/store/', 'src/scan/', 'src/chunk/', 'src/features/', 'src/graph/'] },
  { gate: 'fever', when: ['src/commands/search.ts', 'src/features/', 'src/chunk/', 'src/embed/', 'src/text/', 'src/scan/frontmatter.ts'] },
  { gate: 'baseline', when: ['src/', 'benchmark/', 'package.json', 'package-lock.json'] },
  { gate: 'quality-baseline', when: ['src/'] },
];

export const GATE_NAMES = DIFF_MAP.map((row) => row.gate);

// Every path or prefix the diff map names, for a harness test to check each one still exists.
export const DIFF_MAP_PATHS = [...new Set(DIFF_MAP.flatMap((row) => row.when))];

// A directory prefix (ends in '/') matches by startsWith; a bare path matches exactly.
function pathOwesRow(path, prefixes) {
  return prefixes.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));
}

// gate name -> the changed paths that triggered it, for --dry-run's explanation. A gate absent
// from the diff owes nothing and is not a key.
export function owedReasons(paths) {
  const reasons = new Map();
  for (const { gate, when } of DIFF_MAP) {
    const matched = paths.filter((p) => pathOwesRow(p, when));
    if (matched.length > 0) reasons.set(gate, matched);
  }
  return reasons;
}

export function owedGates(paths) {
  return new Set(owedReasons(paths).keys());
}
