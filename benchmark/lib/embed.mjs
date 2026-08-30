// Static-model embedding for bakeoff/sweep, built on the library's own embed path: no
// safetensors parsing or encode math duplicated here.
import { basename } from 'node:path';
import { toStore } from '../../dist/esm/embed/query.js';
import { staticProvider } from '../../dist/esm/embed/static.js';
import { downloadModel } from '../../dist/esm/embed/store.js';

// The static tier's shipped default plus the smaller W8 8M candidate; any other Hugging Face
// model2vec id works via --model.
export const MODELS = [{ id: 'minishlab/potion-retrieval-32M' }, { id: 'minishlab/potion-base-8M' }];

export async function loadModel(id = MODELS[0].id) {
  const t0 = Number(process.hrtime.bigint()) / 1e6;
  const dir = await downloadModel(id, (file, into) => console.error(`fetching ${id}/${file} into ${into}`));
  const sha = basename(dir); // snapshots/<sha>
  const provider = await staticProvider(dir);
  const loadMs = Number(process.hrtime.bigint()) / 1e6 - t0;
  return { embedFull: (text) => provider.embedQuery(text), dims: provider.dims, loadMs, id, sha };
}

// Storage lever: slice + re-normalize (Matryoshka), quantized through toStore's int8 scale and
// immediately dequantized back to float, so offline cosine scoring feels the same precision loss the real int8 storage path does.
export function leverVec(full, dims, int8) {
  const { v, scale } = toStore(full, dims, int8);
  if (!int8) return v;
  const out = new Float32Array(dims);
  for (let d = 0; d < dims; d++) out[d] = Math.round(v[d] / scale) * scale;
  return out;
}
