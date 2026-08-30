#!/usr/bin/env node

// Rebuild-parity gate: every logical table plus ranked search output (a table dump alone misses a
// silently unranked lexical index). See benchmark/oracle.mjs for the sibling parity-gate shape.
// usage: node benchmark/store-dump.mjs capture <outDir> [--corpus <name|path>] [--store sqlite,duckdb,turso] [--scenario cold|incremental]
//        node benchmark/store-dump.mjs compare <dirA> <dirB>

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'assert';
import { CORPUS_NAMES, corpusPath, writeTreeConfig } from './lib/corpus.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALL_STORES = ['sqlite', 'duckdb', 'turso'];
const SCENARIOS = ['cold', 'incremental'];

// >= 10 terms of varying selectivity: near-stopword frequency down to domain-specific and a
// two-word phrase, so a ranking regression (order OR score) has somewhere to show up.
const QUERY_SET = ['the', 'and', 'note', 'data', 'search', 'system', 'index', 'config', 'database', 'plugin', 'workflow', 'markdown vault'];

// Logical tables in dump order; `feature` gates a table that only exists when that feature is on.
const TABLES = [
  { name: 'frontmatter', orderBy: '"path"' },
  { name: 'content', orderBy: '"path"' },
  { name: 'preset_files', orderBy: '"path", preset' },
  { name: 'links', orderBy: 'src, target, embed', feature: 'links' },
  { name: 'sections', orderBy: '"path", idx', feature: 'sections' },
  { name: 'tags', orderBy: '"path", tag', feature: 'tags' },
  { name: 'embeddings', orderBy: '"path", chunk', feature: 'embed' },
];

// Binary vectors (sqlite BLOB, duckdb FLOAT[], turso F32_BLOB) surface as a Buffer/Uint8Array or a
// plain number array depending on engine; both need a stable text form, hence the hex/array cases.
function serializeValue(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'bigint') return `${v}n`;
  if (Buffer.isBuffer(v)) return `hex:${v.toString('hex')}`;
  if (v instanceof Uint8Array) return `hex:${Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('hex')}`;
  if (Array.isArray(v)) return `[${v.map(serializeValue).join(',')}]`;
  return JSON.stringify(v);
}

// One row per line, keys sorted so column order (which can differ across a store's own row shape)
// never causes a spurious diff.
function serializeRow(row) {
  const cols = Object.keys(row).sort();
  return `{${cols.map((c) => `${JSON.stringify(c)}:${serializeValue(row[c])}`).join(',')}}`;
}

async function dumpRanking(lib, store, cfg) {
  const lines = [];
  for (const q of QUERY_SET) {
    const rows = await lib.search(store, cfg, q, { k: 10 });
    lines.push(`== ${JSON.stringify(q)} (${rows.length} rows) ==`);
    for (const row of rows) lines.push(serializeRow(row));
  }
  return lines;
}

async function dumpTables(store, cfg, featureEnabled) {
  const lines = [];
  for (const table of TABLES) {
    if (table.feature && !featureEnabled(cfg, table.feature)) continue;
    const stmt = await store.prepare(`SELECT * FROM ${table.name} ORDER BY ${table.orderBy}`);
    const rows = await stmt.all();
    lines.push(`== ${table.name} (${rows.length} rows) ==`);
    for (const row of rows) lines.push(serializeRow(row));
  }
  return lines;
}

// v3 presets config, shared by both scenarios so a warm reopen sees the same config it cold-built with.
function buildConfig(storeName, tree, embedDefaults) {
  const presets = { default: { include: ['**/*.md'] } };
  writeTreeConfig(tree, { version: 3, presets, queries: {}, embed: embedDefaults }, { store: storeName });
  return { presets, queries: {}, embed: embedDefaults, baseDir: tree, configPath: null, store: storeName };
}

async function openOrThrow(lib, cfg, storeName) {
  try {
    return await lib.open(cfg);
  } catch (err) {
    throw new Error(`store "${storeName}" failed to open -- its dependency may be missing or misconfigured: ${err.message}`);
  }
}

// Ranking runs before the table dump: search() embeds any pending rows as a side effect, so the
// embeddings table is fully populated by the time it's read.
async function dumpStore(lib, featureEnabled, store, cfg, storeDir) {
  writeFileSync(join(storeDir, 'ranking.txt'), `${(await dumpRanking(lib, store, cfg)).join('\n')}\n`);
  writeFileSync(join(storeDir, 'tables.txt'), `${(await dumpTables(store, cfg, featureEnabled)).join('\n')}\n`);
}

// Cold build, one store: clear .sense (stores share one cache filename, so a stale one from a
// different engine would otherwise be opened instead of rebuilt), reconcile, then dump both halves.
async function captureStore(lib, featureEnabled, embedDefaults, storeName, tree, outDir) {
  const storeDir = join(outDir, storeName);
  mkdirSync(storeDir, { recursive: true });
  rmSync(join(tree, '.sense'), { recursive: true, force: true });
  const cfg = buildConfig(storeName, tree, embedDefaults);

  const { store } = await openOrThrow(lib, cfg, storeName);
  try {
    await dumpStore(lib, featureEnabled, store, cfg, storeDir);
  } finally {
    await store.close();
  }
  rmSync(join(tree, '.sense'), { recursive: true, force: true });
}

// Below turso's FTS_REBUILD_THRESHOLD (250 changed files) so incremental capture exercises its
// per-row FTS maintenance branch, not the bulk rebuild a cold build always takes.
const DELETE_COUNT = 5;
const MODIFY_COUNT = 5;
// Distinctive enough that it cannot already be a corpus key; verified against the corpus below anyway.
const NEW_FRONTMATTER_KEY = 'senseBenchIncrementalProbe';
const NEW_FRONTMATTER_VALUE = 'incremental-scenario-probe';
const APPENDED_LINE = 'Appended by the incremental benchmark scenario.\n';
// Pinned so a dumped _mtime is reproducible; the real write time would differ run to run.
const FIXED_MTIME = new Date('2020-01-01T00:00:00Z');

// `.md` paths under tree, relative and forward-slashed, dotdirs (.git, .sense) excluded, sorted.
function listMarkdownFiles(tree) {
  const out = [];
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), relPath);
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(relPath);
    }
  };
  walk(tree, '');
  return out.sort();
}

// Same delimiter logic as src/scan/frontmatter.ts's splitFrontmatter, so the insertion point
// matches what the real parser will see. No open block: wraps a fresh one around the body.
function injectFrontmatterKey(raw, key, value) {
  const line = `${key}: ${JSON.stringify(value)}\n`;
  const open = raw.match(/^---\r?\n/);
  if (open) {
    const rest = raw.slice(open[0].length);
    const close = rest.match(/^---\r?(\n|$)/m);
    if (close && close.index !== undefined) {
      const insertAt = open[0].length + close.index;
      return `${raw.slice(0, insertAt)}${line}${raw.slice(insertAt)}`;
    }
  }
  return `---\n${line}---\n\n${raw}`;
}

// The probe key must be new to the whole corpus, not just the files it's added to -- otherwise
// the cold build would already have created the column and the ALTER-mid-life branch stays dead.
function assertKeyUnused(tree, mdFiles, key) {
  for (const rel of mdFiles) {
    assert(!readFileSync(join(tree, rel), 'utf8').includes(key), `frontmatter probe key "${key}" already appears in ${rel} -- pick a different NEW_FRONTMATTER_KEY`);
  }
}

// Warm-cache build, one store: cold build, delete/modify a deterministic set of notes, reconcile
// again by reopening, then dump. Restores every touched file's bytes in a finally (shared cache).
async function captureStoreIncremental(lib, featureEnabled, embedDefaults, storeName, tree, outDir) {
  const storeDir = join(outDir, storeName);
  mkdirSync(storeDir, { recursive: true });
  rmSync(join(tree, '.sense'), { recursive: true, force: true });
  const cfg = buildConfig(storeName, tree, embedDefaults);

  const cold = await openOrThrow(lib, cfg, storeName);
  await cold.store.close();

  const mdFiles = listMarkdownFiles(tree);
  assert(mdFiles.length >= DELETE_COUNT + MODIFY_COUNT, `incremental scenario needs at least ${DELETE_COUNT + MODIFY_COUNT} markdown notes, found ${mdFiles.length} in ${tree}`);
  assertKeyUnused(tree, mdFiles, NEW_FRONTMATTER_KEY);
  const toDelete = mdFiles.slice(0, DELETE_COUNT);
  const toModify = mdFiles.slice(DELETE_COUNT, DELETE_COUNT + MODIFY_COUNT);

  // Captured before any mutation, so the finally below can put the corpus back byte-for-byte.
  const originals = new Map();
  for (const rel of [...toDelete, ...toModify]) originals.set(rel, readFileSync(join(tree, rel)));

  // Populated by the finally below; checked after it so a restore failure never overwrites
  // whatever error the try block itself threw.
  const restoreFailures = [];
  try {
    for (const rel of toDelete) rmSync(join(tree, rel));
    for (const rel of toModify) {
      const withKey = injectFrontmatterKey(originals.get(rel).toString('utf8'), NEW_FRONTMATTER_KEY, NEW_FRONTMATTER_VALUE);
      const abs = join(tree, rel);
      writeFileSync(abs, `${withKey.endsWith('\n') ? withKey : `${withKey}\n`}${APPENDED_LINE}`);
      utimesSync(abs, FIXED_MTIME, FIXED_MTIME);
    }

    const warm = await openOrThrow(lib, cfg, storeName);
    const { store } = warm;
    try {
      await dumpStore(lib, featureEnabled, store, cfg, storeDir);
    } finally {
      await store.close();
    }
  } finally {
    // Every file gets a restore attempt even if one fails, so a single bad write doesn't leave the rest mutated.
    for (const [rel, bytes] of originals) {
      try {
        writeFileSync(join(tree, rel), bytes);
      } catch (err) {
        restoreFailures.push(`${rel}: ${err.message}`);
      }
    }
  }
  if (restoreFailures.length > 0) {
    const msg = `incremental scenario failed to restore ${restoreFailures.length} file(s) in the shared corpus at ${tree} -- it is left mutated: ${restoreFailures.join('; ')}`;
    console.error(msg);
    throw new Error(msg);
  }
  rmSync(join(tree, '.sense'), { recursive: true, force: true });
}

async function runCapture(args) {
  const outDirArg = args.find((a) => !a.startsWith('--'));
  const flag = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : dflt;
  };
  if (!outDirArg) {
    console.error('usage: node benchmark/store-dump.mjs capture <outDir> [--corpus <name|path>] [--store sqlite,duckdb,turso] [--scenario cold|incremental]');
    process.exit(2);
  }
  const outDir = resolve(outDirArg);
  const corpusArg = flag('corpus', 'obsidian-hub');
  const tree = CORPUS_NAMES.includes(corpusArg) ? corpusPath(corpusArg) : resolve(corpusArg);
  assert(existsSync(tree), `corpus tree not found: ${tree}`);
  const stores = flag('store', ALL_STORES.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const scenario = flag('scenario', 'cold');
  assert(SCENARIOS.includes(scenario), `--scenario must be one of ${SCENARIOS.join(', ')}, got "${scenario}"`);

  const lib = await import(pathToFileURL(join(repoRoot, 'dist', 'esm', 'index.js')).href);
  const { featureEnabled, DEFAULT_EMBED_MODEL } = await import(pathToFileURL(join(repoRoot, 'dist', 'esm', 'config', 'index.js')).href);
  const embedDefaults = { model: DEFAULT_EMBED_MODEL, provider: 'static' };

  mkdirSync(outDir, { recursive: true });
  const capture = scenario === 'incremental' ? captureStoreIncremental : captureStore;
  for (const storeName of stores) {
    console.log(`capturing ${storeName} (${scenario})...`);
    await capture(lib, featureEnabled, embedDefaults, storeName, tree, outDir);
  }
  console.log(`capture complete: ${stores.join(', ')} -> ${outDir}`);
}

// First differing lines, both sides, with two lines of context -- enough to see which row (its
// serialized "path"/query header) diverged without dumping the whole file.
function compareLines(label, a, b) {
  if (a.length !== b.length) console.error(`${label}: line count differs (${a.length} vs ${b.length})`);
  const max = Math.max(a.length, b.length);
  let firstDiff = -1;
  for (let i = 0; i < max; i++) {
    if (a[i] !== b[i]) {
      firstDiff = i;
      break;
    }
  }
  if (firstDiff === -1 && a.length === b.length) {
    console.log(`${label}: clean (${a.length} lines)`);
    return true;
  }
  console.error(`${label}: differs at line ${firstDiff + 1}${clockOnly(a, b) ? ', in _mtime/_ctime only' : ''}`);
  // Filesystem timestamps, not reconcile output: a corpus touched between the two captures moves
  // them on every row. Named so a stale baseline is not mistaken for a behaviour change.
  if (clockOnly(a, b)) console.error(`${label}: both captures must come from one sitting with the corpus unchanged between them; re-capture the baseline`);
  const from = Math.max(0, firstDiff - 2);
  const to = Math.min(max, firstDiff + 3);
  for (let i = from; i < to; i++) {
    const marker = i === firstDiff ? '>' : ' ';
    console.error(`${marker} ${i + 1} A: ${a[i] ?? '<EOF>'}`);
    console.error(`${marker} ${i + 1} B: ${b[i] ?? '<EOF>'}`);
  }
  return false;
}

// True when every differing line differs only in the filesystem-derived timestamp columns.
function clockOnly(a, b) {
  if (a.length !== b.length) return false;
  const CLOCK = new Set(['_mtime', '_ctime']);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    let rowA;
    let rowB;
    try {
      rowA = JSON.parse(a[i]);
      rowB = JSON.parse(b[i]);
    } catch {
      return false;
    }
    const keys = new Set([...Object.keys(rowA), ...Object.keys(rowB)]);
    for (const k of keys) if (rowA[k] !== rowB[k] && !CLOCK.has(k)) return false;
  }
  return true;
}

function compareFile(label, pathA, pathB) {
  const aExists = existsSync(pathA);
  const bExists = existsSync(pathB);
  if (!aExists || !bExists) {
    console.error(`${label}: missing (${aExists ? pathB : pathA} not found)`);
    return false;
  }
  return compareLines(label, readFileSync(pathA, 'utf8').split('\n'), readFileSync(pathB, 'utf8').split('\n'));
}

function runCompare(args) {
  const [dirAArg, dirBArg] = args;
  if (!dirAArg || !dirBArg) {
    console.error('usage: node benchmark/store-dump.mjs compare <dirA> <dirB>');
    process.exit(2);
  }
  const dirA = resolve(dirAArg);
  const dirB = resolve(dirBArg);
  const subdirs = (dir) => readdirSync(dir).filter((d) => statSync(join(dir, d)).isDirectory());
  const storesA = new Set(subdirs(dirA));
  const storesB = new Set(subdirs(dirB));
  const stores = [...new Set([...storesA, ...storesB])].sort();

  let ok = true;
  for (const s of stores) {
    if (!storesA.has(s) || !storesB.has(s)) {
      console.error(`store "${s}": present in only one directory`);
      ok = false;
      continue;
    }
    const tables = compareFile(`${s}/tables.txt`, join(dirA, s, 'tables.txt'), join(dirB, s, 'tables.txt'));
    const ranking = compareFile(`${s}/ranking.txt`, join(dirA, s, 'ranking.txt'), join(dirB, s, 'ranking.txt'));
    ok = ok && tables && ranking;
  }
  if (ok) console.log(`compare: clean across ${stores.length} store(s) (${stores.join(', ')})`);
  process.exit(ok ? 0 : 1);
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'capture') {
  await runCapture(rest);
} else if (mode === 'compare') {
  runCompare(rest);
} else {
  console.error('usage: node benchmark/store-dump.mjs capture <outDir> [--corpus <name|path>] [--store sqlite,duckdb,turso] [--scenario cold|incremental]');
  console.error('       node benchmark/store-dump.mjs compare <dirA> <dirB>');
  process.exit(2);
}
