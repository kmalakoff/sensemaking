import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import assert from 'assert';
import { qualityRetrievalIdentity } from '../../benchmark/lib/quality-retrieval-identity.mjs';
import { scratchDir } from '../lib/scratch.ts';

const SOURCE_FILES = ['src/commands/scope.ts', 'src/commands/search.ts', 'src/commands/signals.ts', 'src/errors.ts', 'src/index.ts', 'src/output/search-error.ts'];
const COLLECTION_FILES = ['benchmark/steps/quality.mjs', 'benchmark/lib/corpus.mjs', 'benchmark/lib/labels.mjs', 'benchmark/lib/quality.mjs', 'benchmark/lib/quality-work-tree.mjs'];

function write(root: string, path: string, text: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}

function builtPath(format: 'cjs' | 'esm', path: string): string {
  return `dist/${format}/${path.replace(/^src\//, '').replace(/\.ts$/, '.js')}`;
}

function fixture(): string {
  const root = scratchDir('quality-retrieval-identity');
  write(root, 'package.json', '{"name":"quality-retrieval-identity-fixture","version":"1.0.0"}\n');
  write(root, 'package-lock.json', JSON.stringify({ name: 'quality-retrieval-identity-fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'quality-retrieval-identity-fixture', version: '1.0.0', dependencies: { fixture: '1.0.0' } }, 'node_modules/fixture': { version: '1.0.0' } } }));
  for (const path of SOURCE_FILES) {
    write(root, path, `export const source = ${JSON.stringify(path)};\n`);
    for (const format of ['cjs', 'esm'] as const) write(root, builtPath(format, path), `export const built = ${JSON.stringify(`${format}:${path}`)};\n`);
  }
  write(root, 'src/output/output.ts', 'export const presentation = true;\n');
  for (const path of COLLECTION_FILES) write(root, path, `export const collector = ${JSON.stringify(path)};\n`);
  return root;
}

function assertInvalidates(root: string, path: string): void {
  const before = qualityRetrievalIdentity(root);
  write(root, path, `${Date.now()}\n`);
  assert.notEqual(qualityRetrievalIdentity(root).fingerprint, before.fingerprint, `${path} must invalidate retrieval identity`);
}

describe('quality retrieval identity', () => {
  it('is deterministic for unchanged real fixture files', () => {
    const root = fixture();
    assert.deepEqual(qualityRetrievalIdentity(root), qualityRetrievalIdentity(root));
  });

  it('excludes presentation output but includes retrieval output', () => {
    const root = fixture();
    const before = qualityRetrievalIdentity(root);
    write(root, 'src/output/output.ts', 'export const presentation = false;\n');
    assert.equal(qualityRetrievalIdentity(root).fingerprint, before.fingerprint);
    assertInvalidates(root, 'src/output/search-error.ts');
  });

  it('invalidates source and both emitted retrieval counterparts', () => {
    for (const path of ['src/output/search-error.ts', builtPath('cjs', 'src/output/search-error.ts'), builtPath('esm', 'src/output/search-error.ts')]) assertInvalidates(fixture(), path);
  });

  it('ignores a root lock version but invalidates a dependency change', () => {
    const root = fixture();
    const before = qualityRetrievalIdentity(root);
    write(root, 'package-lock.json', JSON.stringify({ name: 'quality-retrieval-identity-fixture', version: '2.0.0', lockfileVersion: 3, packages: { '': { name: 'quality-retrieval-identity-fixture', version: '2.0.0', dependencies: { fixture: '1.0.0' } }, 'node_modules/fixture': { version: '1.0.0' } } }));
    assert.equal(qualityRetrievalIdentity(root).fingerprint, before.fingerprint);
    write(root, 'package-lock.json', JSON.stringify({ name: 'quality-retrieval-identity-fixture', version: '2.0.0', lockfileVersion: 3, packages: { '': { name: 'quality-retrieval-identity-fixture', version: '2.0.0', dependencies: { fixture: '2.0.0' } }, 'node_modules/fixture': { version: '2.0.0' } } }));
    assert.notEqual(qualityRetrievalIdentity(root).fingerprint, before.fingerprint);
  });

  it('invalidates the quality collection harness', () => {
    assertInvalidates(fixture(), 'benchmark/lib/quality.mjs');
  });
});
