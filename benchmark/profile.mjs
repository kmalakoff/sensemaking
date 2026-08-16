// CPU profile of the library's own operations, phase-by-phase. Self-profiling child
// pattern: this file re-invokes itself under --cpu-prof so the profile covers exactly one
// scenario's work, then parses the resulting .cpuprofile and sums self time by callFrame.url.
// usage: node benchmark/profile.mjs <treePath> [scenario ...]
// scenarios: cold nochange update1 search map semantic (default: all applicable)

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { walkMd } from './lib/measure.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const ROOT = join(dirname(THIS_FILE), '..');
const DIST_INDEX = join(ROOT, 'dist', 'esm', 'index.js');
const PROFILE_DIR = join(ROOT, '.tmp', 'profile');

const ALL_SCENARIOS = ['cold', 'nochange', 'update1', 'search', 'map', 'semantic'];

// callFrame.url -> phase name, for frames whose url is specific enough to place. First
// match wins; order goes feature modules before the db/commands modules that call them.
// Returns null for frames too generic to place on their own (native bindings, internals).
function specificPhase(callFrame) {
  const url = callFrame.url || '';
  const fn = callFrame.functionName || '';
  if (url.includes('/dist/esm/scan')) return 'parse';
  if (url.includes('yaml')) return 'yaml';
  if (url.includes('remove-markdown')) return 'strip-markdown';
  if (url.includes('/dist/esm/features/links')) return 'links';
  if (url.includes('/dist/esm/graph')) return 'pagerank';
  if (url.includes('/dist/esm/features/embed') || url.includes('tokenizers')) return 'embed';
  if (url.includes('/dist/esm/db')) return 'db-reconcile';
  if (url.includes('/dist/esm/commands')) return 'commands';
  if (url.includes('node:sqlite') || /sqlite/i.test(fn)) return 'sqlite';
  if (url.includes('node:fs') || url.includes('fast-glob')) return 'fs-glob';
  return null;
}

// Last resort for a frame with no specific match anywhere in its ancestry.
function runtimeOrOther(callFrame) {
  const url = callFrame.url || '';
  const fn = callFrame.functionName || '';
  if (url.startsWith('node:internal') || fn === '(program)' || fn === '(garbage collector)' || fn === '(idle)') return 'runtime';
  return 'other';
}

// --- child: the process actually being profiled, one scenario, exit ---

async function buildCfg(tree) {
  const lib = await import(pathToFileURL(DIST_INDEX).href);
  const configPath = join(tree, 'sense.config.json');
  // A tree with its own config gets its declared features (e.g. embed); a bare tree gets
  // the same minimal config run.mjs uses so cold/nochange/etc. are comparable across trees.
  const cfg = existsSync(configPath) ? lib.loadConfig(configPath) : { presets: { default: { include: ['**/*.md'] } }, queries: {}, baseDir: tree, configPath: null };
  return { lib, cfg };
}

async function runChild(scenario, tree) {
  const { lib, cfg } = await buildCfg(tree);
  if (scenario === 'search' || scenario === 'semantic') {
    const { db } = lib.open(cfg);
    await lib.search(db, cfg, 'the', { k: 10, semantic: scenario === 'semantic' });
    db.close();
  } else if (scenario === 'map') {
    const { db } = lib.open(cfg);
    lib.mapTree(db, cfg);
    db.close();
  } else {
    // prime / cold / nochange / update1: open+close is the whole scenario.
    const { db } = lib.open(cfg);
    db.close();
  }
}

// --- parent: prep state, spawn the profiled child, parse and report ---

function hasEmbedFeature(tree) {
  const configPath = join(tree, 'sense.config.json');
  if (!existsSync(configPath)) return false;
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    // v3: vectors follow presets (absent semantic = on); older configs keyed features.embed.
    if (cfg.presets) return Object.values(cfg.presets).some((p) => p.semantic !== false);
    return Boolean(cfg.features?.embed);
  } catch {
    return false;
  }
}

// Untimed run of the same child code, cache-building side effect only -- keeps the
// profiled child's capture down to the scenario itself, not the crawl behind it.
function primeCache(tree) {
  const res = spawnSync(process.execPath, [THIS_FILE, '--child', 'prime', tree], { stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`prime run failed (exit ${res.status})`);
}

function prepare(scenario, tree) {
  if (scenario === 'cold') {
    rmSync(join(tree, '.sense'), { recursive: true, force: true });
    return;
  }
  primeCache(tree);
  if (scenario === 'update1') {
    const rel = walkMd(tree)[0] ?? null;
    if (!rel) throw new Error('no markdown files found to touch for update1');
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(tree, rel), future, future);
  }
}

function parseProfile(path) {
  const profile = JSON.parse(readFileSync(path, 'utf8'));
  const totalUs = profile.endTime - profile.startTime;
  const totalMs = totalUs / 1000;
  const totalSamples = profile.samples ? profile.samples.length : profile.nodes.reduce((a, n) => a + (n.hitCount || 0), 0);
  const intervalUs = profile.samplingInterval || (totalSamples ? totalUs / totalSamples : 0);

  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parentOf = new Map();
  for (const n of profile.nodes) for (const c of n.children || []) parentOf.set(c, n.id);

  // V8 charges self time to the innermost frame, which for fs reads / regex exec / sqlite
  // calls is a native binding with an empty url -- so a leaf-only url match would dump
  // most of parse/yaml/sqlite into "other". Climb to the nearest ancestor whose own url
  // is specific enough to place, and inherit its phase.
  const classifyCache = new Map();
  function classify(nodeId) {
    if (classifyCache.has(nodeId)) return classifyCache.get(nodeId);
    let id = nodeId;
    let phase = null;
    while (id !== undefined) {
      phase = specificPhase(byId.get(id).callFrame);
      if (phase) break;
      id = parentOf.get(id);
    }
    if (!phase) phase = runtimeOrOther(byId.get(nodeId).callFrame);
    classifyCache.set(nodeId, phase);
    return phase;
  }

  const phaseMs = new Map();
  const funcMs = new Map(); // "functionName\0url" -> self ms
  for (const node of profile.nodes) {
    const selfMs = (node.hitCount || 0) * (intervalUs / 1000);
    if (selfMs <= 0) continue;
    const phase = classify(node.id);
    phaseMs.set(phase, (phaseMs.get(phase) || 0) + selfMs);
    const key = `${node.callFrame.functionName || '(anonymous)'}\0${node.callFrame.url || ''}`;
    funcMs.set(key, (funcMs.get(key) || 0) + selfMs);
  }
  return { totalMs, phaseMs, funcMs };
}

function report(scenario, totalMs, phaseMs, funcMs) {
  console.log(`\n== ${scenario} ==  total ${totalMs.toFixed(1)} ms`);
  const phases = [...phaseMs.entries()].sort((a, b) => b[1] - a[1]);
  console.log('phase           self ms      %');
  for (const [phase, ms] of phases) {
    const pct = totalMs > 0 ? (ms / totalMs) * 100 : 0;
    console.log(`${phase.padEnd(15)} ${ms.toFixed(1).padStart(8)}  ${pct.toFixed(1).padStart(5)}%`);
  }

  const top = [...funcMs.entries()]
    .map(([key, ms]) => {
      const [name, url] = key.split('\0');
      return { name, url, ms };
    })
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 10);
  console.log('\ntop functions:');
  for (const f of top) {
    console.log(`  ${f.name.padEnd(30)} ${basename(f.url).padEnd(22)} ${f.ms.toFixed(1)} ms`);
  }
}

function runScenario(scenario, tree) {
  prepare(scenario, tree);

  const profFile = `${scenario}.cpuprofile`;
  const res = spawnSync(process.execPath, ['--cpu-prof', '--cpu-prof-dir', PROFILE_DIR, '--cpu-prof-name', profFile, THIS_FILE, '--child', scenario, tree], { stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`${scenario}: child failed (exit ${res.status})`);
    return;
  }

  const profPath = join(PROFILE_DIR, profFile);
  const { totalMs, phaseMs, funcMs } = parseProfile(profPath);
  report(scenario, totalMs, phaseMs, funcMs);
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv[0] === '--child') {
    await runChild(argv[1], argv[2]);
    return;
  }

  const [treeArg, ...scenarioArgs] = argv;
  if (!treeArg) {
    console.error('usage: node benchmark/profile.mjs <treePath> [scenario ...]');
    console.error(`scenarios: ${ALL_SCENARIOS.join(' ')} (default: all applicable)`);
    process.exit(2);
  }
  if (!existsSync(DIST_INDEX)) {
    console.error('dist/esm is missing -- run `npx tsds build` first');
    process.exit(1);
  }
  const tree = resolve(treeArg);
  if (!existsSync(tree)) {
    console.error(`tree not found: ${tree}`);
    process.exit(2);
  }

  const embedOn = hasEmbedFeature(tree);
  const requested = scenarioArgs.length > 0 ? scenarioArgs : ALL_SCENARIOS;

  mkdirSync(PROFILE_DIR, { recursive: true });
  console.log(`.cpuprofile files written under ${PROFILE_DIR} (not deleted -- inspect or rm at will)`);

  for (const scenario of requested) {
    if (!ALL_SCENARIOS.includes(scenario)) {
      console.error(`unknown scenario: ${scenario} (expected one of ${ALL_SCENARIOS.join(' ')})`);
      continue;
    }
    if (scenario === 'semantic' && !embedOn) {
      console.log(`\n== semantic ==  skipped: no preset with semantic enabled in the tree's sense.config.json`);
      continue;
    }
    runScenario(scenario, tree);
  }
}

await main();
