#!/usr/bin/env node
// Parity gate against Obsidian's own metadata cache (the reference implementation): compares tags, resolved
// links, unresolved md-intent links, and block extents. Requires Obsidian running with the vault open, the `obsidian` CLI on PATH, and `npm run build` first (block extents import the built dist/esm, not src/); the vault itself is never written to, only copied to a temp dir that's removed on exit.

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [vaultName, vaultPath] = process.argv.slice(2);
if (!vaultName || !vaultPath) {
  console.error('usage: node benchmark/oracle.mjs <vault-name> <vault-path>');
  process.exit(2);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(repoRoot, '.tmp'), { recursive: true });
const work = mkdtempSync(join(repoRoot, '.tmp', 'oracle-'));

try {
  // 1. Obsidian's parse, from its own cache. Inline tags carry '#'; frontmatter tags are left raw so
  // normalization differences surface in the diff. headings/sections are 0-indexed over the raw file (frontmatter included).
  const dumpPath = join(work, 'oracle.json');
  const code = `const fs=require('fs'); const out=app.vault.getMarkdownFiles().map(f=>{const c=app.metadataCache.getFileCache(f)||{}; return {p:f.path, inline:(c.tags||[]).map(t=>t.tag), fm:c.frontmatter ? (c.frontmatter.tags ?? c.frontmatter.tag ?? null) : null, hasFm:!!c.frontmatter, resolved:Object.keys(app.metadataCache.resolvedLinks[f.path]||{}), unresolved:Object.keys(app.metadataCache.unresolvedLinks[f.path]||{}), headings:(c.headings||[]).map(h=>({l:h.level,s:h.position.start.line,e:h.position.end.line})), sections:(c.sections||[]).map(s=>({t:s.type,s:s.position.start.line,e:s.position.end.line}))}}); fs.writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify(out)); 'wrote ' + out.length`;
  execFileSync('obsidian', [`vault=${vaultName}`, 'eval', `code=${code}`], { stdio: ['ignore', 'inherit', 'inherit'] });
  // The CLI can exit 0 with empty stdout before the eval's write lands; the dump file is the signal.
  const deadline = Date.now() + 120_000;
  while (!existsSync(dumpPath)) {
    if (Date.now() > deadline) throw new Error(`oracle dump did not appear at ${dumpPath} within 120s; is the vault fully loaded in Obsidian?`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const oracle = JSON.parse(readFileSync(dumpPath, 'utf8'));

  // macOS hands out NFD paths while Obsidian reports NFC and collapses non-breaking spaces in
  // paths; compare (and look up copied files) on Obsidian's form.
  const canon = (s) => s.normalize('NFC').replace(/\u00a0/g, ' ');

  // 2. sense's parse, on a copy so the vault itself is never written to. `copied` maps
  // canon(relPath) -> absolute-path-in-tree for the block-extent pass below, which needs each file's raw bytes.
  const tree = join(work, 'tree');
  const copied = new Map();
  const walk = (dir) => {
    for (const e of readdirSync(join(vaultPath, dir), { withFileTypes: true })) {
      const rel = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '.obsidian' || e.name === '.trash' || e.name === '.git') continue;
        walk(rel);
      } else if (e.name.endsWith('.md')) {
        const dest = join(tree, rel);
        cpSync(join(vaultPath, rel), dest);
        copied.set(canon(rel.split(sep).join('/')), dest);
      }
    }
  };
  walk('.');
  const cli = join(repoRoot, 'bin', 'cli.js');
  writeFileSync(join(tree, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['**/*.md'] } }, queries: {} }));
  const query = (sql) => {
    const dump = spawnSync(process.execPath, [cli, 'sql', sql, '--format', 'json'], { cwd: tree, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (dump.status !== 0) {
      console.error(dump.stderr);
      process.exit(1);
    }
    return JSON.parse(dump.stdout);
  };
  const ours = new Map();
  for (const row of query('SELECT "path", tag FROM tags ORDER BY "path", tag')) {
    const p = row.path.replace(/\\/g, '/');
    if (!ours.has(p)) ours.set(p, new Set());
    ours.get(p).add(row.tag);
  }
  const ourEdges = new Map(); // src -> Set(dst), resolved only
  const ourDead = new Map(); // src -> Set(target as written), md-intent only
  const mdIntent = (t) => {
    const base = t.split('/').pop().split('#')[0];
    return !base.includes('.') || base.toLowerCase().endsWith('.md');
  };
  for (const row of query('SELECT src, target, dst FROM links ORDER BY src')) {
    const src = row.src.replace(/\\/g, '/');
    if (row.dst !== null) {
      if (!ourEdges.has(src)) ourEdges.set(src, new Set());
      ourEdges.get(src).add(row.dst.replace(/\\/g, '/'));
    } else if (mdIntent(row.target)) {
      if (!ourDead.has(src)) ourDead.set(src, new Set());
      ourDead.get(src).add(row.target);
    }
  }

  // 3. Diff. Obsidian's grain: inline (# stripped) unioned with frontmatter entries.
  const theirs = new Map();
  for (const x of oracle) {
    const t = new Set(x.inline.map((s) => s.replace(/^#/, '')));
    const fm = Array.isArray(x.fm) ? x.fm : x.fm != null ? [x.fm] : [];
    for (const v of fm) if (typeof v === 'string' && v.trim()) t.add(v.trim().replace(/^#/, ''));
    theirs.set(x.p, t);
  }
  const theirEdges = new Map();
  const theirDead = new Map();
  for (const x of oracle) {
    theirEdges.set(x.p, new Set((x.resolved ?? []).filter((d) => d.toLowerCase().endsWith('.md'))));
    theirDead.set(x.p, new Set((x.unresolved ?? []).filter(mdIntent)));
  }

  const nfc = (m) => new Map([...m].map(([k, v]) => [canon(k), new Set([...v].map(canon))]));
  const diffSection = (label, oursMap, theirsMap) => {
    const paths = new Set([...oursMap.keys(), ...theirsMap.keys()]);
    let differing = 0;
    for (const p of [...paths].sort()) {
      const o = oursMap.get(p) ?? new Set();
      const t = theirsMap.get(p) ?? new Set();
      const oursOnly = [...o].filter((x) => !t.has(x)).sort();
      const theirsOnly = [...t].filter((x) => !o.has(x)).sort();
      if (oursOnly.length || theirsOnly.length) {
        differing++;
        console.log(`${label} ${p}`);
        if (oursOnly.length) console.log(`  sense only:    ${oursOnly.join(', ')}`);
        if (theirsOnly.length) console.log(`  obsidian only: ${theirsOnly.join(', ')}`);
      }
    }
    console.log(`${label}: ${differing} differing / ${paths.size} files${differing === 0 ? ' -- parity' : ''}`);
    return differing;
  };
  const total = diffSection('tags', nfc(ours), nfc(theirs)) + diffSection('links', nfc(ourEdges), nfc(theirEdges)) + diffSection('dead-links', nfc(ourDead), nfc(theirDead));

  // 4. Block extents: src/chunk's parse() (imported from the built dist/esm, a real-consumer check) against
  // metadataCache's headings/sections. parse() is 1-indexed over the frontmatter-stripped body; Obsidian is 0-indexed over the raw file (frontmatter included); `offset` (frontmatter's line count) maps ours onto Obsidian's coordinates.
  const { parse } = await import(pathToFileURL(join(repoRoot, 'dist', 'esm', 'chunk', 'index.js')).href);
  const { splitFrontmatter } = await import(pathToFileURL(join(repoRoot, 'dist', 'esm', 'scan', 'frontmatter.js')).href);

  // A theirs-side extent tiled with no non-blank gaps by a run of oursOnly blocks: Obsidian folded several
  // mdast nodes into one section (or the reverse, checked both ways). Blank gaps are expected (mdast emits no node for a blank separator); any non-blank gap means it isn't a real tiling.
  const gapsBlank = (rawLines, covering) => {
    for (let k = 1; k < covering.length; k++) {
      for (let line = covering[k - 1].e + 1; line < covering[k].s; line++) {
        if (rawLines[line] !== undefined && rawLines[line].trim() !== '') return false;
      }
    }
    return true;
  };
  // Shared bookkeeping for every tile* class: find the `from`-item's covering subset of `into` via `cover`,
  // validate via `ok`, then splice both out and record an example via `describe`. Each class supplies only its own cover/ok/describe.
  const tileClass = (from, into, bucket, exampleLimit, cover, ok, describe) => {
    for (let i = from.length - 1; i >= 0; i--) {
      const item = from[i];
      const covering = cover(item);
      if (!covering || covering.length === 0 || !ok(item, covering)) continue;
      bucket.count++;
      if (bucket.examples.length < exampleLimit) bucket.examples.push(describe(item, covering));
      from.splice(i, 1);
      for (const c of covering) into.splice(into.indexOf(c), 1);
    }
  };
  const coveringOf = (arr, lo, hi) => arr.filter((x) => x.s >= lo && x.e <= hi).sort((a, b) => a.s - b.s);

  const tileTheirs = (rawLines, theirsOnly, oursOnly, predicate, bucket, label) =>
    tileClass(
      theirsOnly,
      oursOnly,
      bucket,
      4,
      (t) => (predicate(t) ? coveringOf(oursOnly, t.s, t.e) : null),
      (t, covering) => covering[0].s === t.s && covering[covering.length - 1].e === t.e && gapsBlank(rawLines, covering),
      (t, covering) => `${label} obsidian ${t.t} ${t.s}-${t.e} vs sense [${covering.map((c) => `${c.type}:${c.s}-${c.e}`).join(', ')}]`
    );
  const tileOurs = (rawLines, theirsOnly, oursOnly, bucket, label) =>
    tileClass(
      oursOnly,
      theirsOnly,
      bucket,
      4,
      (o) => coveringOf(theirsOnly, o.s, o.e),
      (o, covering) => covering[0].s === o.s && covering[covering.length - 1].e === o.e && gapsBlank(rawLines, covering),
      (o, covering) => `${label} sense ${o.type} ${o.s}-${o.e} vs obsidian [${covering.map((c) => `${c.t}:${c.s}-${c.e}`).join(', ')}]`
    );
  // A one-line edge shift: both sides agree on a block but disagree by one line at exactly one edge
  // (blank-line-at-boundary handling). Runs before the %%-cascade passes below so it keeps first claim on matches the cascade would otherwise also cover.
  const tileEdgeAdjust = (theirsOnly, oursOnly, bucket, label) =>
    tileClass(
      theirsOnly,
      oursOnly,
      bucket,
      3,
      (t) => {
        const o = oursOnly.find((o) => (Math.abs(o.s - t.s) === 1 && o.e === t.e) || (o.s === t.s && Math.abs(o.e - t.e) === 1));
        return o ? [o] : null;
      },
      () => true,
      (t, [o]) => `${label} obsidian ${t.t} ${t.s}-${t.e} vs sense ${o.type} ${o.s}-${o.e}`
    );

  // trailing-blank: Obsidian's section end can absorb a run of trailing blank/whitespace-only lines (beyond what
  // edge-adjust tolerates) that mdast trims at the block's last content line. Requires the start to line up exactly and every absorbed line to be genuinely blank; unrelated to %%.
  const tileTrailingBlank = (rawLines, theirsOnly, oursOnly, bucket, label) =>
    tileClass(
      theirsOnly,
      oursOnly,
      bucket,
      3,
      (t) => coveringOf(oursOnly, t.s, t.e),
      (t, covering) => {
        const covHi = covering[covering.length - 1].e;
        if (covering[0].s !== t.s || covHi === t.e) return false;
        for (let line = covHi + 1; line <= t.e; line++) {
          if (rawLines[line] !== undefined && rawLines[line].trim() !== '') return false;
        }
        return gapsBlank(rawLines, covering);
      },
      (t, covering) => `${label} obsidian ${t.t} ${t.s}-${t.e} vs sense [${covering.map((c) => `${c.type}:${c.s}-${c.e}`).join(', ')}]`
    );

  // %%-cascade: a %% marker at a theirs-section boundary gets glued by mdast's lazy continuation onto the
  // open CommonMark block on the other side, shifting the boundary. Unlike the plain tiling classes, a shortfall at either edge is accepted when every line is blank or owned by another (pre-mutation) block -- genuinely swallowed, not missing.
  const linesOwnedElsewhere = (rawLines, blocks, excludeSet, from, to, filterFn) => {
    for (let line = from; line <= to; line++) {
      if (rawLines[line] !== undefined && rawLines[line].trim() === '') continue;
      if (!blocks.some((b) => !excludeSet.includes(b) && (!filterFn || filterFn(b)) && line >= b.s && line <= b.e)) return false;
    }
    return true;
  };
  // Theirs side: a comment section whose covering ours-blocks fall short of its extent at
  // either edge, where the shortfall is blank or owned by another (already-mapped) our block.
  const tileTheirsCascade = (rawLines, ourSections, theirsOnly, oursOnly, bucket, label) =>
    tileClass(
      theirsOnly,
      oursOnly,
      bucket,
      4,
      (t) => (t.t === 'comment' ? coveringOf(oursOnly, t.s, t.e) : null),
      (t, covering) => {
        const covLo = covering[0].s;
        const covHi = covering[covering.length - 1].e;
        const prefixOk = covLo === t.s || linesOwnedElsewhere(rawLines, ourSections, covering, t.s, covLo - 1, undefined);
        const suffixOk = covHi === t.e || linesOwnedElsewhere(rawLines, ourSections, covering, covHi + 1, t.e, undefined);
        return prefixOk && suffixOk && gapsBlank(rawLines, covering);
      },
      (t, covering) => `${label} obsidian ${t.t} ${t.s}-${t.e} vs sense [${covering.map((c) => `${c.type}:${c.s}-${c.e}`).join(', ')}]`
    );
  // Ours side: mirror of the above -- an mdast block glued past a single theirs section (e.g. a list running
  // through a swallowed %% into what Obsidian sees as its own following section). The shortfall must be owned by a theirs 'comment' section, keeping this %%-anchored.
  const tileOursCascade = (rawLines, theirSections, theirsOnly, oursOnly, bucket, label) =>
    tileClass(
      oursOnly,
      theirsOnly,
      bucket,
      4,
      (o) => coveringOf(theirsOnly, o.s, o.e),
      (o, covering) => {
        const covLo = covering[0].s;
        const covHi = covering[covering.length - 1].e;
        const isComment = (b) => b.t === 'comment';
        const prefixOk = covLo === o.s || linesOwnedElsewhere(rawLines, theirSections, covering, o.s, covLo - 1, isComment);
        const suffixOk = covHi === o.e || linesOwnedElsewhere(rawLines, theirSections, covering, covHi + 1, o.e, isComment);
        return prefixOk && suffixOk && gapsBlank(rawLines, covering);
      },
      (o, covering) => `${label} sense ${o.type} ${o.s}-${o.e} vs obsidian [${covering.map((c) => `${c.t}:${c.s}-${c.e}`).join(', ')}]`
    );

  // A standalone block-reference anchor line (^blockid alone) is metadata Obsidian folds into the preceding
  // block, never its own section; mdast has no such rule and parses it as its own paragraph.
  const BLOCK_REF_LINE = /^\^[A-Za-z0-9-]+$/;

  const headingBuckets = { differing: 0, examples: [] };
  const typeLabelCounts = new Map(); // "obsidianType -> senseType" -> count, matched extents only
  let frontmatterSections = 0;
  const eofPhantom = { count: 0, examples: [] };
  const blockRefAnchor = { count: 0, examples: [] };
  const commentSwallow = { count: 0, examples: [] };
  const commentCascade = { count: 0, examples: [] };
  const listContinuation = { count: 0, examples: [] };
  const sectionMerge = { count: 0, examples: [] };
  const edgeAdjust = { count: 0, examples: [] };
  const trailingBlank = { count: 0, examples: [] };
  const malformedFrontmatter = { count: 0, examples: [] };
  const unexplained = { count: 0, examples: [] };
  let filesCompared = 0;

  for (const x of oracle) {
    const dest = copied.get(canon(x.p));
    if (!dest) continue; // not a markdown file sense indexed (shouldn't happen)
    filesCompared++;
    const raw = readFileSync(dest, 'utf8');
    const rawLines = raw.split('\n');
    const { body } = splitFrontmatter(raw);
    const offset = raw.split('\n').length - body.split('\n').length;
    const blocks = parse(body);

    // Section extents. Obsidian's 'yaml' section (the frontmatter block) has no counterpart --
    // parse() never sees frontmatter -- so it is excluded from comparison, not silently matched.
    const ourSections = blocks.map((b) => ({ type: b.type, s: b.startLine + offset - 1, e: b.endLine + offset - 1 }));
    const theirSections = (x.sections ?? []).filter((s) => s.t !== 'yaml');
    frontmatterSections += (x.sections ?? []).length - theirSections.length;

    // Malformed-frontmatter precondition (class 3): the file's first line is blank, so splitFrontmatter never
    // recognizes the following `---` as a fence. Gated on Obsidian's cache independently agreeing there is no frontmatter (hasFm false), so this fires only where both parsers already agree it's ordinary body text.
    const malformedFrontmatterPrecondition = (rawLines[0] ?? '').trim() === '' && /^---\s*$/.test(rawLines[1] ?? '') && x.hasFm !== true;

    // Headings: (0-indexed start line, level) pairs. A heading sense finds inside an Obsidian comment section is
    // invisible to Obsidian (comments never contribute to c.headings); one under the malformed-frontmatter precondition is the Setext/empty-list tiebreak (class 3, below). Both are documented, not left as diffs.
    const commentRanges = theirSections.filter((s) => s.t === 'comment');
    const insideComment = (line) => commentRanges.some((c) => line >= c.s && line <= c.e);
    const ourHeadings = new Set(blocks.filter((b) => b.type === 'heading').map((b) => `${b.startLine + offset - 1}:${b.depth}`));
    const theirHeadings = new Set((x.headings ?? []).map((h) => `${h.s}:${h.l}`));
    const oursOnlyH = [];
    for (const k of [...ourHeadings].filter((k) => !theirHeadings.has(k))) {
      const line = Number(k.split(':')[0]);
      if (insideComment(line)) {
        commentCascade.count++;
        if (commentCascade.examples.length < 4) commentCascade.examples.push(`${x.p} sense heading ${k} hidden inside an Obsidian comment (excluded from c.headings)`);
      } else if (malformedFrontmatterPrecondition) {
        malformedFrontmatter.count++;
        if (malformedFrontmatter.examples.length < 4) malformedFrontmatter.examples.push(`${x.p} sense heading ${k} (Setext/empty-list tiebreak in pseudo-frontmatter text; Obsidian also has no frontmatter here)`);
      } else {
        oursOnlyH.push(k);
      }
    }
    const theirsOnlyH = [...theirHeadings].filter((k) => !ourHeadings.has(k));
    if (oursOnlyH.length || theirsOnlyH.length) {
      headingBuckets.differing++;
      if (headingBuckets.examples.length < 3) headingBuckets.examples.push(`${x.p} sense-only:[${oursOnlyH.join(',')}] obsidian-only:[${theirsOnlyH.join(',')}]`);
    }

    const ourMap = new Map(ourSections.map((b) => [`${b.s}:${b.e}`, b]));
    const theirMap = new Map(theirSections.map((s) => [`${s.s}:${s.e}`, s]));
    const oursOnly = [];
    for (const [k, b] of ourMap) {
      const t = theirMap.get(k);
      if (t) {
        const key = `${t.t} -> ${b.type}`;
        typeLabelCounts.set(key, (typeLabelCounts.get(key) ?? 0) + 1);
      } else {
        oursOnly.push(b);
      }
    }
    let theirsOnly = theirSections.filter((s) => !ourMap.has(`${s.s}:${s.e}`));
    if (oursOnly.length === 0 && theirsOnly.length === 0) continue;

    // Class: Obsidian's `getFileCache` appends a zero-width 'text'/'element' pair one line past EOF for some
    // files ending in inline HTML -- a renderer phantom, not a markdown block; mdast never produces anything there.
    theirsOnly = theirsOnly.filter((t) => {
      if (t.t !== 'text' && t.t !== 'element') return true;
      eofPhantom.count++;
      if (eofPhantom.examples.length < 3) eofPhantom.examples.push(`${x.p} ${t.t} ${t.s}-${t.e}`);
      return false;
    });

    // Class: a standalone block-reference anchor line, content-matched (no theirs counterpart
    // exists at all -- Obsidian folds it into the preceding block's metadata).
    for (let i = oursOnly.length - 1; i >= 0; i--) {
      const o = oursOnly[i];
      if (o.type === 'paragraph' && o.s === o.e && BLOCK_REF_LINE.test((rawLines[o.s] ?? '').trim())) {
        blockRefAnchor.count++;
        if (blockRefAnchor.examples.length < 3) blockRefAnchor.examples.push(`${x.p} sense ${o.type} ${o.s}-${o.e} (raw "${rawLines[o.s].trim()}")`);
        oursOnly.splice(i, 1);
      }
    }

    // Tiling classes, run to a fixed point (freeing entries for one class can enable another): comment-swallow
    // (mdast parses markdown inside an opaque %%...%%), list-continuation (Obsidian's lazy HTML/comment-line list continuation vs CommonMark's list-interruption rules), section-merge (same tiling shape, any other pairing), and %%-cascade both directions (a glued %% shifts a comment boundary or lets an ours block run past it).
    let before;
    do {
      before = theirsOnly.length + oursOnly.length;
      tileTheirs(rawLines, theirsOnly, oursOnly, (t) => t.t === 'comment', commentSwallow, x.p);
      tileTheirs(rawLines, theirsOnly, oursOnly, (t) => t.t === 'list', listContinuation, x.p);
      tileTheirs(rawLines, theirsOnly, oursOnly, () => true, sectionMerge, x.p);
      tileOurs(rawLines, theirsOnly, oursOnly, sectionMerge, x.p);
      tileEdgeAdjust(theirsOnly, oursOnly, edgeAdjust, x.p);
      tileTrailingBlank(rawLines, theirsOnly, oursOnly, trailingBlank, x.p);
      tileTheirsCascade(rawLines, ourSections, theirsOnly, oursOnly, commentCascade, x.p);
      tileOursCascade(rawLines, theirSections, theirsOnly, oursOnly, commentCascade, x.p);
    } while (theirsOnly.length + oursOnly.length < before);

    // Class 3: malformed-frontmatter Setext/empty-list tiebreak, gated on the file-level precondition verified
    // above so it never absorbs an unrelated diff. The shortfall this narrow class explains is specifically a heading absorbing the boundary line.
    if (malformedFrontmatterPrecondition) {
      const isHeading = (b) => b.type === 'heading';
      for (let i = theirsOnly.length - 1; i >= 0; i--) {
        const t = theirsOnly[i];
        const covering = oursOnly.filter((o) => o.s >= t.s && o.e <= t.e).sort((a, b) => a.s - b.s);
        if (covering.length === 0) continue;
        const covLo = covering[0].s;
        const covHi = covering[covering.length - 1].e;
        const prefixOk = covLo === t.s || linesOwnedElsewhere(rawLines, ourSections, covering, t.s, covLo - 1, isHeading);
        const suffixOk = covHi === t.e || linesOwnedElsewhere(rawLines, ourSections, covering, covHi + 1, t.e, isHeading);
        if (!prefixOk || !suffixOk || !gapsBlank(rawLines, covering)) continue;
        malformedFrontmatter.count++;
        if (malformedFrontmatter.examples.length < 4) malformedFrontmatter.examples.push(`${x.p} obsidian ${t.t} ${t.s}-${t.e} vs sense [${covering.map((c) => `${c.type}:${c.s}-${c.e}`).join(', ')}] (pseudo-frontmatter Setext/empty-list tiebreak)`);
        theirsOnly.splice(i, 1);
        for (const c of covering) oursOnly.splice(oursOnly.indexOf(c), 1);
      }
    }

    // Whatever is left is not explained by a documented representation class.
    for (const t of theirsOnly) {
      unexplained.count++;
      if (unexplained.examples.length < 40) unexplained.examples.push(`${x.p} obsidian only: ${t.t} ${t.s}-${t.e}`);
    }
    for (const o of oursOnly) {
      unexplained.count++;
      if (unexplained.examples.length < 40) unexplained.examples.push(`${x.p} sense only: ${o.type} ${o.s}-${o.e}`);
    }
  }

  console.log(`\nblock-extents: ${filesCompared} files compared`);
  console.log(`headings: ${headingBuckets.differing} differing / ${filesCompared} files${headingBuckets.differing === 0 ? ' -- parity' : ''}`);
  for (const ex of headingBuckets.examples) console.log(`  ${ex}`);
  console.log(`section type labels (extent matched, type strings differ by design -- Obsidian's flavor types vs sense's BlockType):`);
  for (const [k, n] of [...typeLabelCounts].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);
  console.log(`frontmatter sections (Obsidian 'yaml', excluded -- parse() never sees frontmatter): ${frontmatterSections}`);
  console.log(`eof-phantom (Obsidian's zero-width 'text'/'element' one line past EOF): ${eofPhantom.count}`);
  for (const ex of eofPhantom.examples) console.log(`  ${ex}`);
  console.log(`block-ref anchor (standalone ^blockid line folded into the preceding block by Obsidian, its own paragraph to mdast): ${blockRefAnchor.count}`);
  for (const ex of blockRefAnchor.examples) console.log(`  ${ex}`);
  console.log(`comment-swallow (Obsidian's opaque %%...%% vs mdast parsing its markdown content): ${commentSwallow.count}`);
  for (const ex of commentSwallow.examples) console.log(`  ${ex}`);
  console.log(`%%-cascade (a %% marker glued by mdast's lazy continuation onto a neighboring block shifts a comment boundary, or lets that block run past what Obsidian treats as a separate following section; also excludes headings hidden inside a comment): ${commentCascade.count}`);
  for (const ex of commentCascade.examples) console.log(`  ${ex}`);
  console.log(`list-continuation (Obsidian's lenient list continuation across an intervening HTML/comment line vs CommonMark's list-interruption rules): ${listContinuation.count}`);
  for (const ex of listContinuation.examples) console.log(`  ${ex}`);
  console.log(`section-merge (same tiling shape, other type pairings): ${sectionMerge.count}`);
  for (const ex of sectionMerge.examples) console.log(`  ${ex}`);
  console.log(`edge-adjust (one-line boundary disagreement): ${edgeAdjust.count}`);
  for (const ex of edgeAdjust.examples) console.log(`  ${ex}`);
  console.log(`trailing-blank (Obsidian's section end absorbs a run of trailing blank/whitespace-only lines mdast trims; start matches exactly, unrelated to %%): ${trailingBlank.count}`);
  for (const ex of trailingBlank.examples) console.log(`  ${ex}`);
  console.log(`malformed-frontmatter tiebreak (leading blank line defeats frontmatter detection on both sides; the resulting pseudo-frontmatter text hits a Setext-heading/empty-list-item ambiguity mdast and Obsidian resolve differently): ${malformedFrontmatter.count}`);
  for (const ex of malformedFrontmatter.examples) console.log(`  ${ex}`);
  console.log(`unexplained (not covered by a documented class -- candidate bugs): ${unexplained.count}`);
  for (const ex of unexplained.examples) console.log(`  ${ex}`);

  process.exit(total === 0 && headingBuckets.differing === 0 && unexplained.count === 0 ? 0 : 1);
} finally {
  rmSync(work, { recursive: true, force: true });
}
