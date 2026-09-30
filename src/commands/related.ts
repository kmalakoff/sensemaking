import type { ResolvedConfig, SearchOverrides } from '../config/index.ts';
import { embedConfig, embedEnabled, resolveSearch } from '../config/index.ts';
import { ensureDocumentEmbeddings, hasEmbedding, similarNotes } from '../embed/query.ts';
import { localModelMissing, MODEL_FILENAMES } from '../embed/store.ts';
import { SenseError } from '../errors.ts';
import { serialQuery } from '../lib/serial-query.ts';
import type { Store } from '../store/types.ts';
import { resolveNote } from './peek.ts';
import { scopedPaths, scopeHasEmbeddings, withMaterializedVectorScope } from './scope.ts';
import { assertQuerySnapshot } from './snapshot.ts';

export const RELATED_DEFAULT_K = 5;

/**
 * Options for {@link relatedNotes}. Scope fields filter result candidates, not the seed note;
 * `k` defaults to 5, matching the CLI.
 */
export interface RelatedOptions extends SearchOverrides {
  k?: number;
}

export type RelatedResult = {
  path: string;
  similarity: number;
};

export async function resolveRelatedSeed(store: Store, pathArg: string): Promise<string> {
  const paths = ((await (await store.prepare('SELECT "path" FROM frontmatter')).all()) as Array<{ path: string }>).map((row) => row.path);
  return resolveNote(paths, pathArg);
}

/**
 * Returns the notes most similar to an indexed seed, excluding the seed and notes linked either
 * way. The seed resolves across the indexed tree even when it is outside the candidate scope.
 */
export function relatedNotes(store: Store, cfg: ResolvedConfig, pathArg: string, options: RelatedOptions = {}): Promise<RelatedResult[]> {
  return serialQuery(store, () => relatedIndexed(store, cfg, pathArg, options, options.k ?? RELATED_DEFAULT_K));
}

async function relatedIndexed(store: Store, cfg: ResolvedConfig, pathArg: string, overrides: RelatedOptions, k: number): Promise<RelatedResult[]> {
  if (!Number.isFinite(k) || !Number.isInteger(k) || k <= 0) {
    throw new SenseError('SEARCH_OPTION_INVALID', `related option "k" must be a positive finite integer, got ${String(k)}`);
  }
  // Vectors are the only signal `related` has, so every way of not having them is an error
  // naming the cause; an empty result means one thing, nothing near in meaning.
  const effective = resolveSearch(cfg, overrides);
  if (!embedEnabled(cfg)) {
    throw new SenseError('EMBED_DISABLED', 'related ranks notes by meaning, and this tree has no embedding model; add an "embed" block naming one to sense.config.json (a Hugging Face id fetches automatically at first use; `sense download` prefetches it) -- search works without it, on words and links');
  }
  // search gates on the same signal, so a preset's declared signals mean one thing: without
  // this check an overlapping vectors-on preset would answer for a scope that declined them.
  if (effective.signals.vectors === undefined) {
    throw new SenseError('PRESET_NOT_SEMANTIC', `preset "${effective.presetName}" has no "vectors" signal, so this scope has no vectors and related has no other signal; search it instead (words and links), or add "vectors" to that preset's signals`);
  }
  // A downloadable HF id can be fetched by preparation. Only a local path with missing files
  // can never fetch itself.
  const e = embedConfig(cfg); // embedEnabled(cfg) above guarantees this is set
  if (localModelMissing(e)) {
    throw new SenseError('EMBED_MODEL_MISSING', `related ranks notes by meaning, so it needs the embedding model, but the local model path "${e.model}" is missing ${MODEL_FILENAMES}; point embed.model at a directory containing them (search still works without it, on words and links)`);
  }

  return store.transaction(async () => {
    await assertQuerySnapshot(store, cfg);
    // Repeat effective preset validation inside the snapshot that supplies its durable scope.
    const current = resolveSearch(cfg, overrides);
    if (current.signals.vectors === undefined) {
      throw new SenseError('PRESET_NOT_SEMANTIC', `preset "${current.presetName}" has no "vectors" signal, so this scope has no vectors and related has no other signal; search it instead (words and links), or add "vectors" to that preset's signals`);
    }

    const path = await resolveRelatedSeed(store, pathArg);
    const outbound = ((await (await store.prepare('SELECT DISTINCT dst FROM links WHERE src = ? AND dst IS NOT NULL AND dst != src')).all(path)) as Array<{ dst: string }>).map((r) => r.dst);
    const backlinks = ((await (await store.prepare('SELECT DISTINCT src FROM links WHERE dst = ? AND src != dst')).all(path)) as Array<{ src: string }>).map((r) => r.src);
    const exclude = new Set([path, ...outbound, ...backlinks]);
    const allowed = await scopedPaths(store, cfg, overrides);
    // The seed may sit outside a narrowed candidate scope; both it and every eligible result must
    // be ready, while pending vectors in unrelated notes do not block this operation.
    await ensureDocumentEmbeddings(store, cfg, new Set([...allowed, path]));
    if (!(await hasEmbedding(store, path))) {
      throw new SenseError('NOTE_NOT_EMBEDDED', `${path} has no indexed text to compare -- a note that is frontmatter only, or empty, has nothing to rank by meaning`);
    }
    if (!(await scopeHasEmbeddings(store, cfg, allowed))) return [];
    return withMaterializedVectorScope(store, allowed, () => similarNotes(store, cfg, path, { exclude, allowed, k }));
  });
}
