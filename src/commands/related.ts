import type { ResolvedConfig, SearchOverrides } from '../config/index.ts';
import { embedConfig, embedEnabled, resolveSearch } from '../config/index.ts';
import { embedPending, hasEmbedding, similarNotes } from '../embed/query.ts';
import { localModelMissing, MODEL_FILENAMES } from '../embed/store.ts';
import { SenseError } from '../errors.ts';
import type { Store } from '../store/types.ts';
import { resolveNote } from './peek.ts';
import { scopedPaths, scopeHasEmbeddings } from './scope.ts';

// Notes most similar by cosine, excluding self and everything already linked either way.
// Its own command, not a peek section: a full embeddings scan is ~480ms at 26k notes.
export async function relatedNotes(store: Store, cfg: ResolvedConfig, pathArg: string, overrides: SearchOverrides, k: number): Promise<Array<{ path: string; similarity: number }>> {
  const paths = ((await (await store.prepare('SELECT "path" FROM frontmatter')).all()) as Array<{ path: string }>).map((r) => r.path);
  const path = resolveNote(paths, pathArg);

  const outbound = ((await (await store.prepare('SELECT DISTINCT dst FROM links WHERE src = ? AND dst IS NOT NULL AND dst != src')).all(path)) as Array<{ dst: string }>).map((r) => r.dst);
  const backlinks = ((await (await store.prepare('SELECT DISTINCT src FROM links WHERE dst = ? AND src != dst')).all(path)) as Array<{ src: string }>).map((r) => r.src);
  const exclude = new Set([path, ...outbound, ...backlinks]);

  // Vectors are the only signal `related` has, so every way of not having them is an error
  // naming the cause. An empty table then means one thing: nothing near in meaning that this
  // note does not already link to, which is a real answer.
  const effective = resolveSearch(cfg, overrides);
  if (!embedEnabled(cfg)) {
    throw new SenseError('EMBED_DISABLED', 'related ranks notes by meaning, and this tree has no embedding model; add an "embed" block naming one to sense.config.json (a Hugging Face id fetches automatically at first use; `sense download` prefetches it) -- search works without it, on words and links');
  }
  // search gates on the same signal (see wantsVectors above); reading it here too keeps a
  // preset's declared signals meaning one thing. Without this, an overlapping vectors-on
  // preset's vectors would answer for a scope that declined them.
  if (effective.signals.vectors === undefined) {
    throw new SenseError('PRESET_NOT_SEMANTIC', `preset "${effective.presetName}" has no "vectors" signal, so this scope has no vectors and related has no other signal; search it instead (words and links), or add "vectors" to that preset's signals`);
  }
  // A downloadable HF id proceeds -- embedPending's getProvider call fetches it lazily on
  // consent. Only a local path with missing files can never fetch itself.
  const e = embedConfig(cfg); // embedEnabled(cfg) above guarantees this is set
  if (localModelMissing(e)) {
    throw new SenseError('EMBED_MODEL_MISSING', `related ranks notes by meaning, so it needs the embedding model, but the local model path "${e.model}" is missing ${MODEL_FILENAMES}; point embed.model at a directory containing them (search still works without it, on words and links)`);
  }
  const allowed = await scopedPaths(store, cfg, overrides);
  // Top up pending rows before the seed check, or a fresh index reports every note as
  // having no indexed text until some search has run.
  await embedPending(store, cfg, cfg.baseDir);
  if (!(await hasEmbedding(store, path))) {
    throw new SenseError('NOTE_NOT_EMBEDDED', `${path} has no indexed text to compare -- a note that is frontmatter only, or empty, has nothing to rank by meaning`);
  }
  if (!(await scopeHasEmbeddings(store, cfg, allowed))) return [];
  return similarNotes(store, cfg, path, { exclude, allowed, k });
}
