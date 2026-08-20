import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SUPPORTED_CONFIG_VERSION } from 'sensemaking';
import { packageRoot } from '../lib/cli.ts';

// Published surfaces drift silently: nothing fails when the README stops describing what
// ships. These are the two facts cheap enough to assert -- the rest is RELEASING.md step 5.

const readme = () => readFileSync(join(packageRoot, 'README.md'), 'utf8');

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
