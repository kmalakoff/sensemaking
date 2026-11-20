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

// The binding surface behind the lexical check, as independent literals. Frontmatter VARIANT cells are written through the appender and read back
// with the type tag the writer chose (string, bigint and non-integer number are what mapValue() produces); a NULL cell reads back as null.
export const ENGINE_CHECK_VARIANT_COLUMNS: ReadonlyArray<{ column: string; type: 'VARCHAR' | 'HUGEINT' | 'DOUBLE' }> = [
  { column: 'engine_text', type: 'VARCHAR' },
  { column: 'engine_integer', type: 'HUGEINT' },
  { column: 'engine_real', type: 'DOUBLE' },
];
export const ENGINE_CHECK_VARIANT_ROWS: ReadonlyArray<{ path: string; values: Array<string | bigint | number | null> }> = [
  { path: 'a.md', values: ['plain text', BigInt(7), 2.5] },
  { path: 'b.md', values: [null, null, null] },
];
// A value changed on an existing row: the update must write it and keep the row's other cells.
export const ENGINE_CHECK_VARIANT_UPDATE = { path: 'a.md', column: 'engine_text', value: 'changed text' };

// Three unit-direction vectors (first two components, zero elsewhere) quantized the way embed/query.ts writes them (int8 times a scale);
// a query along the first axis ranks a.md (cosine 1), c.md (100 over sqrt 12500, 0.894 rounded) and b.md (0) in that order.
export const ENGINE_CHECK_VECTORS = {
  scale: 0.01,
  rows: [
    { path: 'a.md', chunk: 0, head: [100, 0] },
    { path: 'b.md', chunk: 0, head: [0, 100] },
    { path: 'c.md', chunk: 0, head: [100, 50] },
  ],
  query: [1, 0],
  expected: [
    { path: 'a.md', similarity: 1 },
    { path: 'c.md', similarity: 0.894 },
    { path: 'b.md', similarity: 0 },
  ],
};

// The registered SQL functions, with the results their documented behaviour gives (segment's from the rewrite table in test/unit/text/segment.test.ts).
export const ENGINE_CHECK_FUNCTIONS: ReadonlyArray<{ sql: string; expected: string | number }> = [
  { sql: `SELECT has('["a","b"]', 'a') AS v`, expected: 1 },
  { sql: `SELECT basename('notes/a.md', '.md') AS v`, expected: 'a' },
  { sql: `SELECT segment('title:数据库') AS v`, expected: 'title_seg:"数 据 库"' },
];

// What to do when an npm-installed engine fails: get a version from the tested range.
export function npmRemedy(pkg: string, range: string): string {
  return `run \`npm install "${pkg}@${range}"\` for a tested version (tested ${range})`;
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

// Runs one named step of an engine check: a thrown error or a returned mismatch description fails the engine, naming the step.
export async function checkEngineStep(store: string, identity: string, remedy: string, label: string, step: () => Promise<string | null>): Promise<void> {
  let mismatch: string | null;
  try {
    mismatch = await step();
  } catch (err) {
    throw engineCheckFailed(store, identity, remedy, `${label} failed (${(err as Error).message})`, err);
  }
  if (mismatch !== null) throw engineCheckFailed(store, identity, remedy, `${label} returned ${mismatch}`);
}

export function engineCheckFailed(store: string, identity: string, remedy: string, failure: string, cause?: unknown): SenseError {
  const error = new SenseError('STORE_CAPABILITY_MISSING', `store "${store}" cannot use ${identity}: ${failure}; ${remedy}`);
  if (cause !== undefined) error.cause = cause;
  return error;
}
