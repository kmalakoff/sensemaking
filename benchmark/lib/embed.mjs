// Static-model embedding for bakeoff/sweep: fetch-once by pinned revision, safetensors plus
// pure-JS tokenizer. model2vec encode: no special tokens, drop unk ids, mean-pool, normalize.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Tokenizer } from '@huggingface/tokenizers';
import { cached } from './cache.mjs';

// Pinned like corpora: revision in the cache key, id + revision in results captions.
export const MODEL = { id: 'minishlab/potion-retrieval-32M', revision: '6fc8051fab2a1e0ee76689cf08c853792ac285e7' };

export function loadModel() {
  const modelDir = cached(`model-${MODEL.id.split('/')[1]}-${MODEL.revision.slice(0, 8)}`, (staging) => {
    for (const file of ['model.safetensors', 'tokenizer.json']) {
      execFileSync('curl', ['-fsSL', '-o', join(staging, file), `https://huggingface.co/${MODEL.id}/resolve/${MODEL.revision}/${file}`]);
    }
  });

  const t0 = Number(process.hrtime.bigint()) / 1e6;
  const raw = readFileSync(join(modelDir, 'model.safetensors'));
  const headerLen = Number(raw.readBigUInt64LE(0));
  const header = JSON.parse(raw.subarray(8, 8 + headerLen).toString('utf8'));
  const [, spec] = Object.entries(header).find(([k]) => k !== '__metadata__');
  if (spec.dtype !== 'F32') throw new Error(`expected F32 tensor, got ${spec.dtype}`);
  const [, dims] = spec.shape;
  const dataStart = raw.byteOffset + 8 + headerLen + spec.data_offsets[0];
  const matrix = dataStart % 4 === 0 ? new Float32Array(raw.buffer, dataStart, spec.shape[0] * dims) : new Float32Array(raw.buffer.slice(dataStart, dataStart + spec.shape[0] * dims * 4));

  const tokenizerJson = JSON.parse(readFileSync(join(modelDir, 'tokenizer.json'), 'utf8'));
  const tok = new Tokenizer(tokenizerJson, {});
  const unkId = tokenizerJson.model?.vocab?.[tokenizerJson.model?.unk_token] ?? -1;
  const loadMs = Number(process.hrtime.bigint()) / 1e6 - t0;

  function embedFull(text) {
    const ids = tok.encode(text, { add_special_tokens: false }).ids.filter((id) => id !== unkId);
    const v = new Float32Array(dims);
    if (ids.length === 0) return v;
    for (const id of ids) {
      const off = id * dims;
      for (let d = 0; d < dims; d++) v[d] += matrix[off + d];
    }
    let norm = 0;
    for (let d = 0; d < dims; d++) {
      v[d] /= ids.length;
      norm += v[d] * v[d];
    }
    norm = Math.sqrt(norm) + 1e-32;
    for (let d = 0; d < dims; d++) v[d] /= norm;
    return v;
  }

  return { embedFull, dims, loadMs };
}

// Storage lever: slice + re-normalize (Matryoshka); int8 rounds through symmetric
// per-vector storage quantization. Docs store the lever; queries stay f32 at its dims.
export function leverVec(full, dims, int8) {
  const v = new Float32Array(dims);
  let norm = 0;
  for (let d = 0; d < dims; d++) norm += full[d] * full[d];
  norm = Math.sqrt(norm) + 1e-32;
  for (let d = 0; d < dims; d++) v[d] = full[d] / norm;
  if (int8) {
    let max = 0;
    for (let d = 0; d < dims; d++) max = Math.max(max, Math.abs(v[d]));
    const scale = max / 127 || 1;
    for (let d = 0; d < dims; d++) v[d] = Math.round(v[d] / scale) * scale;
  }
  return v;
}
