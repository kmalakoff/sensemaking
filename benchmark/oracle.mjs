#!/usr/bin/env node
// Tag-parity gate against Obsidian's own metadata cache: the reference implementation, so a
// parsing release cannot drift from it silently. Requires Obsidian running with the vault
// open, and the `obsidian` CLI on PATH. Nothing is stored: the cache dump and the sense index
// both live in a temp directory and are removed on exit. Pass = zero differing files; any
// diff line is printed with both sides for adjudication.
//
//   node benchmark/oracle.mjs <vault-name> <vault-path>
//
// vault-name is the name Obsidian shows in its vault switcher; vault-path is the same vault
// on disk (the script never writes into it -- markdown files are copied out to temp).

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [vaultName, vaultPath] = process.argv.slice(2);
if (!vaultName || !vaultPath) {
  console.error('usage: node benchmark/oracle.mjs <vault-name> <vault-path>');
  process.exit(2);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'sense-oracle-'));

try {
  // 1. Obsidian's parse, straight from its cache. Inline tags carry '#'; frontmatter comes
  // raw so normalization differences show up in the diff instead of being absorbed here.
  const dumpPath = join(work, 'oracle.json');
  const code = `const fs=require('fs'); const out=app.vault.getMarkdownFiles().map(f=>{const c=app.metadataCache.getFileCache(f)||{}; return {p:f.path, inline:(c.tags||[]).map(t=>t.tag), fm:c.frontmatter ? (c.frontmatter.tags ?? c.frontmatter.tag ?? null) : null}}); fs.writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify(out)); 'wrote ' + out.length`;
  execFileSync('obsidian', [`vault=${vaultName}`, 'eval', `code=${code}`], { stdio: ['ignore', 'inherit', 'inherit'] });
  const oracle = JSON.parse(readFileSync(dumpPath, 'utf8'));

  // 2. sense's parse, on a copy so the vault itself is never written to.
  const tree = join(work, 'tree');
  const walk = (dir) => {
    for (const e of readdirSync(join(vaultPath, dir), { withFileTypes: true })) {
      const rel = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '.obsidian' || e.name === '.trash' || e.name === '.git') continue;
        walk(rel);
      } else if (e.name.endsWith('.md')) {
        cpSync(join(vaultPath, rel), join(tree, rel));
      }
    }
  };
  walk('.');
  const cli = join(repoRoot, 'bin', 'cli.js');
  writeFileSync(join(tree, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['**/*.md'] } }, queries: {} }));
  const dump = spawnSync(process.execPath, [cli, 'sql', 'SELECT "path", tag FROM tags ORDER BY "path", tag', '--format', 'json'], { cwd: tree, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (dump.status !== 0) {
    console.error(dump.stderr);
    process.exit(1);
  }
  const ours = new Map();
  for (const row of JSON.parse(dump.stdout)) {
    const p = row.path.replace(/\\/g, '/');
    if (!ours.has(p)) ours.set(p, new Set());
    ours.get(p).add(row.tag);
  }

  // 3. Diff. Obsidian's grain: inline (# stripped) unioned with frontmatter entries.
  const theirs = new Map();
  for (const x of oracle) {
    const t = new Set(x.inline.map((s) => s.replace(/^#/, '')));
    const fm = Array.isArray(x.fm) ? x.fm : x.fm != null ? [x.fm] : [];
    for (const v of fm) if (typeof v === 'string' && v.trim()) t.add(v.trim().replace(/^#/, ''));
    theirs.set(x.p, t);
  }
  const paths = new Set([...ours.keys(), ...theirs.keys()]);
  let differing = 0;
  for (const p of [...paths].sort()) {
    const o = ours.get(p) ?? new Set();
    const t = theirs.get(p) ?? new Set();
    const oursOnly = [...o].filter((x) => !t.has(x)).sort();
    const theirsOnly = [...t].filter((x) => !o.has(x)).sort();
    if (oursOnly.length || theirsOnly.length) {
      differing++;
      console.log(p);
      if (oursOnly.length) console.log(`  sense only:    ${oursOnly.join(', ')}`);
      if (theirsOnly.length) console.log(`  obsidian only: ${theirsOnly.join(', ')}`);
    }
  }
  console.log(`${differing} differing / ${paths.size} files${differing === 0 ? ' -- parity with Obsidian' : ''}`);
  process.exit(differing === 0 ? 0 : 1);
} finally {
  rmSync(work, { recursive: true, force: true });
}
