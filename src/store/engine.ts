import semver from 'semver';
import { SenseError } from '../errors.ts';

// Which native engine built a derived index. A different engine rebuilds the cache, as a schema change does:
// native index formats and scoring belong to the engine, not to sensemaking's schema.
export const ENGINE_IDENTITY_META_KEY = 'engine_identity';

export function engineIdentity(pkg: string, version: string | undefined): string {
  return `${pkg}@${version ?? 'unknown'}`;
}

/**
 * One version-specific replacement of a store's SQL builders. `range` matches the engine version (the npm package's,
 * or Node's bundled SQLite for sqlite), prereleases included since every `@duckdb/node-api` release is one;
 * `reason` names the observed difference.
 */
export interface EnginePatch<Builders> {
  range: string;
  reason: string;
  builders: Partial<Builders>;
}

// Later patches win where ranges overlap, so a narrower fix is listed after the broader one it refines.
export function selectBuilders<Builders extends object>(defaults: Builders, patches: readonly EnginePatch<Builders>[], version: string | undefined): Builders {
  let selected = defaults;
  for (const patch of patches) {
    if (version !== undefined && semver.satisfies(version, patch.range, { includePrerelease: true })) selected = { ...selected, ...patch.builders };
  }
  return selected;
}

export interface EngineCheckDoc {
  path: string;
  title: string;
  summary: string;
  text: string;
}

// Expected results every store must reproduce. The title match sorts last by path, so an engine whose scores
// collapse to zero (Turso's fts_score silent mode) or lose field weights reorders 'run' and fails the check.
export const ENGINE_CHECK_DOCS: readonly EngineCheckDoc[] = [
  { path: 'b-text.md', title: 'Garden', summary: '', text: 'The dog runs past two cats.' },
  { path: 'c-cjk.md', title: 'Kitchen', summary: '', text: '日本語のメモ' },
  { path: 'z-title.md', title: 'Running dogs', summary: '', text: 'A note about pets.' },
];

export const ENGINE_CHECK_QUERIES: ReadonlyArray<{ terms: string; paths: string[] }> = [
  { terms: 'run', paths: ['z-title.md', 'b-text.md'] },
  { terms: 'dog cat', paths: ['b-text.md'] },
  { terms: '日本', paths: ['c-cjk.md'] },
];

// What to do when an npm-installed engine fails: get a version from the tested range.
export function npmRemedy(pkg: string, range: string): string {
  return `run \`npm install ${pkg}@${range}\` for a tested version (tested ${range})`;
}

// Runs the store's real lexical query over ENGINE_CHECK_DOCS; any thrown error or wrong result fails the engine.
export async function checkEngine(store: string, identity: string, remedy: string, query: (terms: string) => Promise<string[]>): Promise<void> {
  for (const expected of ENGINE_CHECK_QUERIES) {
    let paths: string[];
    try {
      paths = await query(expected.terms);
    } catch (err) {
      throw engineCheckFailed(store, identity, remedy, `searching "${expected.terms}" failed (${(err as Error).message})`);
    }
    if (paths.join('\n') !== expected.paths.join('\n')) {
      throw engineCheckFailed(store, identity, remedy, `searching "${expected.terms}" returned [${paths.join(', ')}], expected [${expected.paths.join(', ')}]`);
    }
  }
}

export function engineCheckFailed(store: string, identity: string, remedy: string, failure: string): SenseError {
  return new SenseError('STORE_CAPABILITY_MISSING', `store "${store}" cannot use ${identity}: ${failure}; ${remedy}`);
}
