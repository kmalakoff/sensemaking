import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { directoryIdentity, identityHash, installedPackageVersion, pathSetIdentity } from './workload-identity.mjs';

export const QUALITY_RETRIEVAL_PATHS = ['src/chunk', 'src/commands/scope.ts', 'src/commands/search.ts', 'src/commands/signals.ts', 'src/config', 'src/embed', 'src/errors.ts', 'src/features', 'src/graph', 'src/index.ts', 'src/lib', 'src/output/search-error.ts', 'src/scan', 'src/store', 'src/text', 'src/workers'];

const SOURCE_FILES = QUALITY_RETRIEVAL_PATHS.filter((path) => path.endsWith('.ts'));
const SOURCE_DIRECTORIES = QUALITY_RETRIEVAL_PATHS.filter((path) => !path.endsWith('.ts'));
const COLLECTION_FILES = ['benchmark/steps/quality.mjs', 'benchmark/lib/corpus.mjs', 'benchmark/lib/labels.mjs', 'benchmark/lib/quality.mjs', 'benchmark/lib/quality-work-tree.mjs'];

function dependencyIdentity(root) {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const rootPackage = { ...(lock.packages?.[''] ?? {}) };
  delete rootPackage.name;
  delete rootPackage.version;
  return identityHash({ lockfile_version: lock.lockfileVersion, root: rootPackage, packages: Object.fromEntries(Object.entries(lock.packages ?? {}).filter(([path]) => path !== '')) });
}

const builtPath = (format, path) => `dist/${format}/${path.replace(/^src\//, '').replace(/\.ts$/, '.js')}`;

export function qualityRetrievalIdentity(root) {
  const inputs = {
    version: 1,
    paths: {
      files: pathSetIdentity(root, SOURCE_FILES),
      directories: Object.fromEntries(SOURCE_DIRECTORIES.map((path) => [path, directoryIdentity(join(root, path))])),
      built_files: pathSetIdentity(
        root,
        SOURCE_FILES.flatMap((path) => [builtPath('cjs', path), builtPath('esm', path)])
      ),
      built_directories: Object.fromEntries(SOURCE_DIRECTORIES.flatMap((path) => ['cjs', 'esm'].map((format) => [`${format}:${path}`, directoryIdentity(join(root, builtPath(format, path)))]))),
    },
    collection: pathSetIdentity(root, COLLECTION_FILES),
    dependencies: dependencyIdentity(root),
    runtime: { node: process.version },
    native_packages: {
      duckdb: installedPackageVersion(root, '@duckdb/node-api'),
      turso: installedPackageVersion(root, '@tursodatabase/database'),
    },
  };
  return { fingerprint: identityHash(inputs), inputs };
}
