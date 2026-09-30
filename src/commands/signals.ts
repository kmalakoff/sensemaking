import type { PreparedSemanticQuery } from '../embed/query.ts';
import { semanticCandidates } from '../embed/query.ts';
import { LINK_EDGES_SQL, toEdges } from '../features/index.ts';
import { personalizedRank } from '../graph/graph.ts';
import type { LexicalHit, Store } from '../store/types.ts';
import { withMaterializedVectorScope } from './scope.ts';

// RRF composes whatever the preset declares; the constant lives here since it belongs to
// the fusion these three functions share, not to search() itself.
const RRF_K = 60;

export type SearchResultVia = 'match' | 'match+link' | 'link' | 'match+vector' | 'match+link+vector' | 'link+vector' | 'vector';

export type Candidates = Map<string, { score: number; via: SearchResultVia }>;

function withVector(via: SearchResultVia): SearchResultVia {
  if (via === 'match') return 'match+vector';
  if (via === 'match+link') return 'match+link+vector';
  if (via === 'link') return 'link+vector';
  return via;
}

// BM25 match rows (store.lexical.query), folded into `candidates` by reciprocal rank scaled by
// the preset's declared weight for this signal. Every other signal is seeded from its output.
export async function wordsCandidates(store: Store, candidates: Candidates, query: string, whereJoin: string, whereCond: string, scopeCond: string, fetch: number, weight: number): Promise<LexicalHit[]> {
  const matchRows = await store.lexical.query(query, { whereJoin, whereCond, scopeCond, limit: fetch });
  matchRows.forEach((r, i) => {
    candidates.set(r.path, { score: weight / (RRF_K + i), via: 'match' });
  });
  return matchRows;
}

// Personalized-PageRank expansion from the word-match seeds, folded into `candidates` at this
// signal's weight. A no-op when there is nothing to seed from (matchRows empty).
export async function linksCandidates(store: Store, candidates: Candidates, matchRows: LexicalHit[], allPaths: string[], allowedPaths: Set<string>, fetch: number, weight: number): Promise<void> {
  if (matchRows.length === 0) return;
  const stmt = await store.prepare(LINK_EDGES_SQL);
  const edges = toEdges((await stmt.all()) as Array<{ src: string; dst: string }>);
  if (edges.length === 0) return;
  // Gates the label only, not the score: restart mass ranks every seed without an incident
  // edge, but dropping it from the score reweights fusion (FEVER hit@10 0.997 -> 0.907).
  const linked = new Set(edges.flat());
  const seeds = new Map(matchRows.map((r, i) => [r.path, 1 / (i + 1)]));
  const ranked = [...personalizedRank(allPaths, edges, seeds)]
    .filter(([path, score]) => score > 1e-9 && allowedPaths.has(path))
    .sort((a, b) => b[1] - a[1] || Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])))
    .slice(0, fetch);
  ranked.forEach(([path], i) => {
    const existing = candidates.get(path);
    if (existing) {
      existing.score += weight / (RRF_K + i);
      if (linked.has(path)) existing.via = 'match+link';
    } else {
      candidates.set(path, { score: weight / (RRF_K + i), via: 'link' });
    }
  });
}

// Vector expansion at the swept flat-region constants (pool = fetch), folded into `candidates`
// at this signal's weight; each row also carries its best chunk's line range and similarity.
export async function vectorsCandidates(store: Store, prepared: PreparedSemanticQuery, candidates: Candidates, fetch: number, allowedPaths: Set<string>, totalPaths: number, weight: number): Promise<{ chunkLines: Map<string, string>; chunkSimilarity: Map<string, number> }> {
  const chunkLines = new Map<string, string>();
  const chunkSimilarity = new Map<string, number>();
  const vec = await withMaterializedVectorScope(store, allowedPaths, () => semanticCandidates(store, prepared, fetch, allowedPaths), totalPaths);
  vec.forEach(({ path, lines, similarity }, i) => {
    chunkLines.set(path, lines);
    chunkSimilarity.set(path, similarity);
    const existing = candidates.get(path);
    if (existing) {
      existing.score += weight / (RRF_K + i);
      existing.via = withVector(existing.via);
    } else {
      candidates.set(path, { score: weight / (RRF_K + i), via: 'vector' });
    }
  });
  return { chunkLines, chunkSimilarity };
}
