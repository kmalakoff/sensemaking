import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cliPath, packageRoot } from '../lib/cli.ts';
import { writeModel } from '../lib/model.ts';
import { tmpTree, writeNote } from '../lib/tree.ts';

// @huggingface/tokenizers (540K, src/embed/static.ts) and franc-min (148K, src/embed/langfit.ts),
// plus the embed provider subtree that reaches them (registry/static/query/langfit/cohere/openai),
// belong only on the semantic path. Two separate leaks shipped this in 0.17.0, both fixed in
// 0.17.1: the commands barrel (src/commands/index.ts) statically re-exporting every command, so
// each src/cli/*.ts now imports its specific command module instead; and src/cli/status.ts
// importing languageDistribution from langfit.ts, which also statically imports franc-min for
// checkLanguageFit -- split into src/embed/distribution.ts (no franc-min) so status.ts's read of
// the persisted counts no longer drags the classifier in. static.ts and langfit.ts each require()
// the two packages lazily rather than importing them at module top, so neither the CLI nor the
// library entry (src/index.ts re-exports search from the commands barrel) resolves them until
// staticProvider/checkLanguageFit actually run. This traces real ESM specifier resolution around
// the built CLI and library entry to hold the invariant permanently: see BENCHMARKING.md's "a
// heavy import belongs inside the one command that uses it".
//
// search and related are NOT light commands: they are the semantic-capable ones, and their own
// command modules statically reach the embed subtree regardless of whether a tree's config even
// has an embed block (module resolution happens at load time, before any runtime branching on
// config). They are asserted as positive controls below rather than held to the clean invariant.

const traceHook = pathToFileURL(join(packageRoot, 'test', 'lib', 'module-trace.mjs')).href;

// Runs a node invocation with the trace hook preloaded and returns the deduped list of watched
// specifiers it resolved. Exit status is deliberately not asserted here: some commands (e.g.
// `related` with no embed block) legitimately exit non-zero, and that is not this test's
// concern -- only what got resolved on the way there.
function trace(nodeArgs: string[], cwd?: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'sense-trace-'));
  const traceFile = join(dir, 'trace.log');
  writeFileSync(traceFile, '');
  spawnSync(process.execPath, nodeArgs, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: `--import ${traceHook}`, SENSE_TEST_TRACE_FILE: traceFile },
  });
  const loaded = [...new Set(readFileSync(traceFile, 'utf8').split('\n').filter(Boolean))];
  rmSync(dir, { recursive: true, force: true });
  return loaded;
}

function traceCli(args: string[], cwd: string): string[] {
  return trace([cliPath, ...args], cwd);
}

function lightTree(): string {
  const baseDir = tmpTree();
  writeFileSync(join(baseDir, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['**/*.md'] } }, queries: {} }));
  writeNote(baseDir, 'one.md', { frontmatter: { title: 'One' }, body: 'An apple every day. See [[two]].' });
  writeNote(baseDir, 'two.md', { frontmatter: { title: 'Two' }, body: 'stone walls' });
  return baseDir;
}

// The audit's own measured list: every non-semantic command a tree-without-vectors invocation
// can reach. Must load neither heavy npm package nor any module of the embed provider subtree.
const LIGHT_COMMANDS: Array<[string, string[]]> = [
  ['status', ['status']],
  ['map', ['map']],
  ['peek', ['peek', 'one.md']],
  ['path', ['path', 'one.md', 'two.md']],
  ['sql', ['sql', 'SELECT path FROM frontmatter']],
];

// The semantic commands: they legitimately reach the embed subtree via their own module's
// static imports (commands/search.ts -> commands/signals.ts -> embed/query.ts), even on a tree
// with no embed block. Positive controls, not clean-invariant commands.
const SEMANTIC_COMMANDS: Array<[string, string[]]> = [
  ['search', ['search', 'apple']],
  ['related', ['related', 'one.md']],
];

describe('lazy embed dependencies', () => {
  it('the trace hook detects a watched specifier (sanity check: proves the assertions below are not vacuously green)', () => {
    const loaded = trace(['--input-type=module', '-e', "await import('franc-min')"]);
    assert.deepEqual(loaded, ['franc-min']);
  });

  for (const [name, args] of LIGHT_COMMANDS) {
    it(`${name} does not resolve the heavy embed subtree on a tree with no embed block`, () => {
      const baseDir = lightTree();
      const loaded = traceCli(args, baseDir);
      rmSync(baseDir, { recursive: true, force: true });
      assert.deepEqual(loaded, [], `unexpectedly loaded: ${loaded.join(', ')}`);
    });
  }

  for (const [name, args] of SEMANTIC_COMMANDS) {
    it(`${name} DOES resolve the embed subtree even with no embed block (positive control: proves the invariant above is not vacuous)`, () => {
      const baseDir = lightTree();
      const loaded = traceCli(args, baseDir);
      rmSync(baseDir, { recursive: true, force: true });
      assert.ok(loaded.length > 0, `expected ${name} to resolve embed modules, got none`);
    });
  }

  it('importing the built library entry resolves neither heavy npm package', () => {
    const entry = pathToFileURL(join(packageRoot, 'dist', 'esm', 'index.js')).href;
    const loaded = trace(['--input-type=module', '-e', `await import('${entry}')`]);
    assert.ok(!loaded.includes('@huggingface/tokenizers'), `expected the tokenizer NOT to load from the library entry, got: ${loaded.join(', ')}`);
    assert.ok(!loaded.includes('franc-min'), `expected franc-min NOT to load from the library entry, got: ${loaded.join(', ')}`);
  });

  it('search resolves both npm packages once an embed block makes the semantic path real', () => {
    const baseDir = tmpTree();
    writeFileSync(join(baseDir, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['**/*.md'] } }, embed: { model: writeModel(), provider: 'static' }, queries: {} }));
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' }, body: 'pomme' });
    const loaded = traceCli(['search', 'pomme'], baseDir);
    rmSync(baseDir, { recursive: true, force: true });
    assert.ok(loaded.includes('@huggingface/tokenizers'), `expected the tokenizer to load once vectors are real, got: ${loaded.join(', ')}`);
    assert.ok(loaded.includes('franc-min'), `expected franc-min to load once checkLanguageFit runs, got: ${loaded.join(', ')}`);
  });
});
