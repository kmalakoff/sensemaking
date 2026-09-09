import assert from 'assert';
import { toStore } from '../../src/embed/query.ts';

export const VECTOR_DIMS = 8;

export interface SeparatedVectorFixture {
  query: Float32Array;
  exact: Float32Array;
  diagonal: Float32Array;
  orthogonal: Float32Array;
  antiParallel: Float32Array;
}

export function separatedVectorFixture(): SeparatedVectorFixture {
  return {
    query: vector(1, 0),
    exact: vector(1, 0),
    diagonal: vector(1, 1),
    orthogonal: vector(0, 1),
    antiParallel: vector(-1, 0),
  };
}

export function assertSeparatedScores(results: readonly { path: string; similarity: number }[]): void {
  const scores = new Map(results.map((result) => [result.path, result.similarity]));
  // Quantizing [1, 1] preserves the 45-degree direction. Store scores round its cosine to 3 decimals.
  const diagonalScore = Math.round(Math.SQRT1_2 * 1000) / 1000;
  assert.strictEqual(scores.get('exact.md'), 1);
  assert.strictEqual(scores.get('diagonal.md'), diagonalScore);
  assert.strictEqual(scores.get('orthogonal.md'), 0);
  assert.strictEqual(scores.get('anti.md'), -1);
}

// Independent cosine oracle for fixtures. A zero vector has no direction; the store contract
// represents that undefined similarity as the finite neutral score 0.
export function cosineOracle(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let d = 0; d < length; d++) {
    dot += a[d] * b[d];
    aNorm += a[d] * a[d];
    bNorm += b[d] * b[d];
  }
  for (let d = length; d < a.length; d++) aNorm += a[d] * a[d];
  for (let d = length; d < b.length; d++) bNorm += b[d] * b[d];
  return aNorm === 0 || bNorm === 0 ? 0 : dot / Math.sqrt(aNorm * bNorm);
}

export function quantizeVector(value: Float32Array, dims = VECTOR_DIMS): { scale: number; vector: Buffer } {
  const { v, scale } = toStore(value, dims, true);
  const q = new Int8Array(dims);
  for (let d = 0; d < dims; d++) q[d] = Math.round(v[d] / scale);
  return { scale, vector: Buffer.from(q.buffer) };
}

function vector(...values: number[]): Float32Array {
  const result = new Float32Array(VECTOR_DIMS);
  values.forEach((value, index) => {
    result[index] = value;
  });
  return result;
}
