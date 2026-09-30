import type { ResolvedConfig, SearchOverrides } from '../config/index.ts';
import { resolveSearch } from '../config/index.ts';
import { SenseError } from '../errors.ts';
import { findPathInSnapshot } from '../graph/traverse.ts';
import { serialQuery } from '../lib/serial-query.ts';
import type { Store } from '../store/types.ts';
import { resolveNote } from './peek.ts';
import { scopedPaths } from './scope.ts';
import { assertQuerySnapshot } from './snapshot.ts';

/**
 * Options for {@link findPath}. Scope fields constrain intermediate nodes; `maxDepth` limits the
 * number of traversed links and must be a positive integer when supplied.
 */
export type PathOptions = Omit<SearchOverrides, 'k'> & {
  maxDepth?: number;
};

/**
 * Finds the shortest undirected link path between two indexed notes. Endpoints resolve across
 * the indexed tree and remain permitted outside the scope applied to intermediate nodes.
 */
export function findPath(store: Store, cfg: ResolvedConfig, fromArg: string, toArg: string, options: PathOptions = {}): Promise<string[] | null> {
  return serialQuery(store, () => findScopedPath(store, cfg, fromArg, toArg, options));
}

async function findScopedPath(store: Store, cfg: ResolvedConfig, fromArg: string, toArg: string, options: PathOptions): Promise<string[] | null> {
  if (options.maxDepth !== undefined && (!Number.isFinite(options.maxDepth) || !Number.isInteger(options.maxDepth) || options.maxDepth <= 0)) {
    throw new SenseError('SEARCH_OPTION_INVALID', `path option "maxDepth" must be a positive finite integer, got ${String(options.maxDepth)}`);
  }
  // Validate the named preset before opening the snapshot; repeat it inside because preset_files
  // and the compatibility assertion below belong to the final published generation.
  resolveSearch(cfg, options);
  return store.transaction(async () => {
    await assertQuerySnapshot(store, cfg);
    resolveSearch(cfg, options);
    const paths = ((await (await store.prepare('SELECT "path" FROM frontmatter')).all()) as Array<{ path: string }>).map((row) => row.path);
    const from = resolveNote(paths, fromArg);
    const to = resolveNote(paths, toArg);
    const allowed = await scopedPaths(store, cfg, options);
    return findPathInSnapshot(store, from, to, { maxDepth: options.maxDepth, allowed });
  });
}
