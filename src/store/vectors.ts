import type { Connection, VectorStore } from './types.ts';

export const NATIVE_VECTOR_SCOPE_TABLE = '_vector_scope';

type NativeVectorScopePhase = 'materializing' | 'active' | 'cleaning';

interface NativeVectorScopeState {
  token: object;
  allowed: Set<string>;
  phase: NativeVectorScopePhase;
}

interface NativeVectorScopeOwnerState {
  vectors?: VectorStore;
  scope?: NativeVectorScopeState;
}

interface NativeVectorScopeOwner {
  bind(vectors: VectorStore): void;
  activeFor(allowed: Set<string> | undefined): boolean;
}

interface NativeVectorScopeReservation {
  activate(): void;
  deactivate(): void;
  invalidate(): void;
}

const nativeVectorScopeOwners = new WeakMap<VectorStore, NativeVectorScopeOwnerState>();

// One owner is constructed beside one native store connection, then bound to that connection's
// VectorStore wrapper. The adapter asks its own owner for a private boolean; no Set or reservation
// can activate another Store, even when a caller reuses the same Set object across both.
export function createNativeVectorScopeOwner(): NativeVectorScopeOwner {
  const owner: NativeVectorScopeOwnerState = {};
  return {
    bind(vectors) {
      if (owner.vectors) throw new Error('native vector scope owner is already bound');
      if (nativeVectorScopeOwners.has(vectors)) throw new Error('VectorStore is already bound to a native vector scope owner');
      owner.vectors = vectors;
      nativeVectorScopeOwners.set(vectors, owner);
    },
    activeFor(allowed) {
      return allowed !== undefined && owner.scope?.phase === 'active' && owner.scope.allowed === allowed;
    },
  };
}

export function reserveNativeVectorScope(vectors: VectorStore, allowed: Set<string>): NativeVectorScopeReservation | null {
  const owner = nativeVectorScopeOwners.get(vectors);
  if (!owner) return null;
  if (owner.scope) throw new Error('native vector scope operation is already active for this Store');

  const token = {};
  owner.scope = { token, allowed, phase: 'materializing' };
  let valid = true;

  const current = (): NativeVectorScopeState => {
    if (!valid || owner.scope?.token !== token) throw new Error('native vector scope reservation is no longer valid');
    return owner.scope;
  };

  return {
    activate() {
      const scope = current();
      if (scope.phase !== 'materializing') throw new Error(`native vector scope cannot activate from ${scope.phase}`);
      scope.phase = 'active';
    },
    deactivate() {
      const scope = current();
      if (scope.phase === 'cleaning') throw new Error('native vector scope cleanup already started');
      scope.phase = 'cleaning';
    },
    invalidate() {
      if (!valid) return;
      if (owner.scope?.token === token) owner.scope = undefined;
      valid = false;
    },
  };
}

// Seed chunks that participate in a `related` scan. Cost is target_chunks x stored_chunks, so a
// heading-dense seed multiplies a full-corpus scan (12.7s at 201 chunks/note unsampled).
export const TARGET_CHUNK_CAP = 16;

// Evenly samples down to at most `cap` rows, so late sections of a long note still get a vote
// instead of being cut off by a fixed prefix.
export function sampleEvenly<T>(rows: T[], cap: number = TARGET_CHUNK_CAP): T[] {
  const step = Math.max(1, Math.ceil(rows.length / cap));
  return rows.filter((_, i) => i % step === 0);
}

// Every store computes a real cosine; clamp float error at the ends and round for the public score.
export function asCosine(score: number): number {
  return Math.round(Math.min(1, Math.max(-1, score)) * 1000) / 1000;
}

// Rank by the computed cosine before rounding for display. Bytewise path order resolves only an
// exact score tie, so two distinguishable similarities never cross a caller's result boundary.
export function compareVectorScores(a: { path: string; score: number }, b: { path: string; score: number }): number {
  const byScore = b.score - a.score;
  if (byScore !== 0) return byScore;
  return Buffer.compare(Buffer.from(a.path), Buffer.from(b.path));
}

export async function pendingRows(conn: Connection): Promise<Array<{ path: string; chunk: number }>> {
  const stmt = await conn.prepare('SELECT "path", chunk FROM embeddings WHERE vector IS NULL ORDER BY "path", chunk');
  return (await stmt.all()) as Array<{ path: string; chunk: number }>;
}

// Whether a note has any chunk with a vector. Distinguishes "nothing is near this note" from
// "this note has no text", which look the same in an empty result.
export async function hasVectorRow(conn: Connection, path: string): Promise<boolean> {
  const stmt = await conn.prepare('SELECT 1 AS ok FROM embeddings WHERE "path" = ? AND vector IS NOT NULL LIMIT 1');
  const row = (await stmt.get(path)) as { ok: number } | undefined;
  return row !== undefined;
}
