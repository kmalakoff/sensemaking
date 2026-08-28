import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import cr from 'cr';
import { SUPPORTED_CONFIG_VERSION } from 'sensemaking';
import { parse } from 'yaml';
import { packageRoot } from '../lib/cli.ts';

// Published surfaces drift silently: nothing fails when the README stops describing what
// ships. These are the two facts cheap enough to assert -- the rest is RELEASING.md step 5.

// Windows checks out CRLF working trees (core.autocrlf), but these assertions are about
// document structure, not the bytes on disk -- normalize so a `\n` in the patterns below means
// the same thing on every platform. `cr` over a hand-rolled replace: it also folds a bare \r,
// which a hand-rolled /\r\n/ misses.
const read = (...parts: string[]) => cr(readFileSync(join(...parts), 'utf8'));

const readme = () => read(packageRoot, 'README.md');

describe('published docs', () => {
  it('README lists every command in the registry', async () => {
    const { COMMANDS } = (await import(pathToFileURL(join(packageRoot, 'dist', 'esm', 'cli', 'index.js')).href)) as { COMMANDS: Record<string, unknown> };
    const text = readme();
    for (const name of Object.keys(COMMANDS)) {
      assert.ok(new RegExp(`\`${name}[\\s"<\`]`).test(text), `${name} is a command but the README never shows it`);
    }
  });

  it('README names every runtime dependency', () => {
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    const text = readme();
    for (const dep of Object.keys(pkg.dependencies)) {
      assert.ok(text.includes(dep), `${dep} is a runtime dependency but the README never names it`);
    }
  });

  it('README config example is on the supported config version', () => {
    const example = JSON.parse(/```json\n([\s\S]*?)```/.exec(readme())?.[1] ?? '{}') as { version?: number };
    assert.equal(example.version, SUPPORTED_CONFIG_VERSION);
  });

  it('package.json description is the README opening sentence', () => {
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { description: string };
    const opening = readme()
      .split(/^#\s.*$/m)[1]
      .trim()
      .split(/\n{2,}/)[0]
      .replace(/\s+/g, ' ')
      .replace(/\.$/, '');
    assert.equal(pkg.description, opening);
  });
});

// Every shipped SKILL.md is installed by tooling that parses its frontmatter as YAML, and an
// unquoted `description:` containing ": " reads as a nested mapping and is skipped entirely.
// Copying the files and diffing them proves nothing about this; parsing them does.
describe('shipped skills', () => {
  const skillDirs = () =>
    readdirSync(join(packageRoot, 'skills'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

  it('every SKILL.md has frontmatter that parses, with a name and description', () => {
    const names = skillDirs();
    assert.ok(names.length > 0, 'no skills found to check');
    for (const name of names) {
      const file = join(packageRoot, 'skills', name, 'SKILL.md');
      const fm = /^---\n([\s\S]*?)\n---\n/.exec(read(file));
      assert.ok(fm, `${name}/SKILL.md has no frontmatter block`);
      const parsed = parse(fm[1]) as { name?: string; description?: string };
      assert.equal(parsed.name, name, `${name}/SKILL.md declares a name that is not its directory`);
      assert.ok(parsed.description && parsed.description.length > 0, `${name}/SKILL.md has no description`);
    }
  });

  it('every skill named in package.json files is actually packed', () => {
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { files: string[] };
    assert.ok(pkg.files.includes('skills'), 'skills/ is not in package.json files');
  });
});

// plans/ is gitignored working material: it is not in the repo a consumer clones and not in
// the package, so a comment pointing at one sends the reader to a file that does not exist.
// A reason worth keeping belongs inline, in the code it explains.
describe('no references to local planning files', () => {
  it('no tracked file points at plans/', () => {
    // This file names the directory it forbids, so it is the one exemption.
    // git ls-files reports posix separators; relative() uses the platform's.
    const self = relative(packageRoot, fileURLToPath(import.meta.url))
      .split(sep)
      .join('/');
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: packageRoot, encoding: 'utf8' }).split('\0').filter(Boolean);
    const offenders = tracked.filter((file) => /\.(ts|js|mjs|cjs|md|json)$/.test(file) && file !== self && !file.startsWith('plans/') && readFileSync(join(packageRoot, file), 'utf8').includes('plans/'));
    assert.deepEqual(offenders, [], `these reference gitignored plans/: ${offenders.join(', ')}`);
  });
});
