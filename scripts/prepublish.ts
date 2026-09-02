// Idiot checks: cheap, static, publish-blocking hygiene with no product behavior in it.
// Runs before the test suite so a forgotten skill or a stale README fails fast, not deep in CI.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import cr from 'cr';
import { parse } from 'yaml';
import { KNOWN_EMBED_KEYS, STORE_NAMES } from '../src/config/index.ts';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const selfPath = relative(packageRoot, fileURLToPath(import.meta.url))
  .split(sep)
  .join('/');

// Windows checks out CRLF; normalize so `\n` means the same thing on every platform.
const read = (...parts: string[]): string => cr(readFileSync(join(...parts), 'utf8'));
const readme = (): string => read(packageRoot, 'README.md');
const pkg = (): { dependencies: Record<string, string>; files: string[]; description: string } => JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));

interface Check {
  name: string;
  run: () => string[];
}

const checks: Check[] = [
  {
    name: 'README names every runtime dependency',
    run: () => {
      const text = readme();
      return Object.keys(pkg().dependencies)
        .filter((dep) => !text.includes(dep))
        .map((dep) => `${dep} is a runtime dependency but the README never names it`);
    },
  },
  {
    name: 'package.json description is the README opening sentence',
    run: () => {
      const opening = readme()
        .split(/^#\s.*$/m)[1]
        .trim()
        .split(/\n{2,}/)[0]
        .replace(/\s+/g, ' ')
        .replace(/\.$/, '');
      const description = pkg().description;
      return description === opening ? [] : [`package.json description "${description}" does not match the README opening sentence "${opening}"`];
    },
  },
  {
    // validate.ts's KNOWN_EMBED_KEYS is the source of truth; schema.json is a separate,
    // editor-facing copy nothing keeps in sync, so a key can validate and still fail editor lint.
    name: 'schema.json embed properties match validate.ts KNOWN_EMBED_KEYS',
    run: () => {
      const schema = JSON.parse(readFileSync(join(packageRoot, 'schema.json'), 'utf8')) as { properties: { embed: { properties: Record<string, unknown> } } };
      const declared = new Set(Object.keys(schema.properties.embed.properties));
      return [...KNOWN_EMBED_KEYS].filter((key) => !declared.has(key)).map((key) => `embed.${key} validates but has no schema.json property, so an editor with additionalProperties:false flags it`);
    },
  },
  {
    // STORE_NAMES is the source of truth; schema.json's enum is the editor-facing copy, and
    // benchmark/gate.mjs reads that enum to decide which stores its battery covers.
    name: 'schema.json store enum matches STORE_NAMES',
    run: () => {
      const schema = JSON.parse(readFileSync(join(packageRoot, 'schema.json'), 'utf8')) as { properties: { store: { enum: string[] } } };
      const declared = [...STORE_NAMES];
      const same = schema.properties.store.enum.length === declared.length && schema.properties.store.enum.every((name, i) => name === declared[i]);
      return same ? [] : [`schema.json store enum ${JSON.stringify(schema.properties.store.enum)} does not match STORE_NAMES ${JSON.stringify(declared)}; a store that validates but is missing from the enum is one the benchmark battery never runs`];
    },
  },
  {
    // Every shipped SKILL.md is installed by tooling that parses its frontmatter as YAML; an
    // unquoted `description:` containing ": " reads as a nested mapping and gets skipped entirely.
    name: 'every SKILL.md has frontmatter that parses, with a name and description',
    run: () => {
      const dir = join(packageRoot, 'skills');
      if (!existsSync(dir)) return ['no skills/ directory found to check'];
      const names = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      if (names.length === 0) return ['no skills found to check'];
      const problems: string[] = [];
      for (const name of names) {
        const file = join(dir, name, 'SKILL.md');
        const fm = /^---\n([\s\S]*?)\n---\n/.exec(read(file));
        if (!fm) {
          problems.push(`${name}/SKILL.md has no frontmatter block`);
          continue;
        }
        const parsed = parse(fm[1]) as { name?: string; description?: string };
        if (parsed.name !== name) problems.push(`${name}/SKILL.md declares a name that is not its directory`);
        if (!parsed.description || parsed.description.length === 0) problems.push(`${name}/SKILL.md has no description`);
      }
      return problems;
    },
  },
  {
    name: 'every skill named in package.json files is actually packed',
    run: () => (pkg().files.includes('skills') ? [] : ['skills/ is not in package.json files']),
  },
  {
    // plans/ is gitignored working material, not in the repo a consumer clones or the package,
    // so a comment pointing at one sends the reader to a file that does not exist.
    name: 'no tracked file points at plans/',
    run: () => {
      // --others --exclude-standard so a not-yet-committed file is scanned too: tracked-only
      // passes a new file's violation locally and fails only once it is committed.
      // maxBuffer above the 1MB default: a large untracked working tree overflows it and the
      // check dies with ENOBUFS instead of reporting.
      const tracked = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: packageRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        .split('\0')
        .filter(Boolean);
      return tracked.filter((file) => /\.(ts|js|mjs|cjs|md|json)$/.test(file) && file !== selfPath && !file.startsWith('plans/') && existsSync(join(packageRoot, file)) && readFileSync(join(packageRoot, file), 'utf8').includes('plans/')).map((file) => `${file} references gitignored plans/`);
    },
  },
];

let failures = 0;
for (const check of checks) {
  const problems = check.run();
  if (problems.length === 0) {
    console.log(`ok   ${check.name}`);
    continue;
  }
  console.log(`FAIL ${check.name}`);
  for (const problem of problems) console.log(`     ${problem}`);
  failures += problems.length;
}

if (failures > 0) {
  console.error(`\n${failures} prepublish check${failures === 1 ? '' : 's'} failed.`);
  process.exit(1);
}
console.log('\nprepublish checks passed.');
