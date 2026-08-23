import type { DatabaseSync } from 'node:sqlite';
import type { ResolvedConfig, SearchOverrides } from '../config/index.ts';
import { embedEnabled, resolveSearch } from '../config/index.ts';
import { SenseError } from '../errors.ts';
import { embedPending, hasEmbedding, modelPresent, similarNotes } from '../features/embed.ts';
import { resolveNote } from './peek.ts';
import { scopedPaths, scopeHasEmbeddings } from './scope.ts';

// Notes most similar by cosine, excluding self and everything already linked either way.
// Its own command, not a peek section: a full embeddings scan is ~480ms at 26k notes.
export async function relatedNotes(db: DatabaseSync, cfg: ResolvedConfig, pathArg: string, overrides: SearchOverrides, k: number): Promise<Array<{ path: string; similarity: number }>> {
  const paths = (db.prepare('SELECT "path" FROM frontmatter').all() as Array<{ path: string }>).map((r) => r.path);
  const path = resolveNote(paths, pathArg);

  const outbound = (db.prepare('SELECT DISTINCT dst FROM links WHERE src = ? AND dst IS NOT NULL').all(path) as Array<{ dst: string }>).map((r) => r.dst);
  const backlinks = (db.prepare('SELECT DISTINCT src FROM links WHERE dst = ?').all(path) as Array<{ src: string }>).map((r) => r.src);
  const exclude = new Set([path, ...outbound, ...backlinks]);

  // Vectors are the only signal `related` has, so every way of not having them is an error
  // naming the cause. An empty table then means one thing: nothing near in meaning that this
  // note does not already link to, which is a real answer.
  const effective = resolveSearch(cfg, overrides);
  if (!embedEnabled(cfg)) {
    throw new SenseError('EMBED_DISABLED', 'related ranks notes by meaning, and this tree has no embedding model; add an "embed" block naming one to sense.config.json, then run `sense download` (search works without it, on words and links)');
  }
  // search gates on the same flag (see wantsVectors above); reading it here too keeps
  // `semantic: false` meaning one thing. Without this, an overlapping semantic-on preset's
  // vectors would answer for a scope that declined them.
  if (!effective.semantic) {
    throw new SenseError('PRESET_NOT_SEMANTIC', `preset "${effective.presetName}" sets "semantic": false, so this scope has no vectors and related has no other signal; search it instead (words and links), or set semantic back on for that preset`);
  }
  if (!modelPresent(cfg)) {
    throw new SenseError('EMBED_MODEL_MISSING', 'related ranks notes by meaning, so it needs the embedding model, which is not downloaded; run `sense download` (search still works without it, on words and links)');
  }
  const allowed = scopedPaths(db, cfg, overrides);
  // Top up pending rows before the seed check, or a fresh index reports every note as
  // having no indexed text until some search has run.
  await embedPending(db, cfg, cfg.baseDir);
  if (!hasEmbedding(db, path)) {
    throw new SenseError('NOTE_NOT_EMBEDDED', `${path} has no indexed text to compare -- a note that is frontmatter only, or empty, has nothing to rank by meaning`);
  }
  if (!scopeHasEmbeddings(db, cfg, allowed)) return [];
  return similarNotes(db, cfg, path, { exclude, allowed, k });
}
