import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SenseError } from '../errors.ts';
import { downloadModel, isDownloadable, MODEL_FILENAMES, MODEL_FILES, modelDir, readLanguages } from './store.ts';
import type { EmbedProvider } from './types.ts';

const BATCH_CAP = 64;

// Model2Vec safetensors + pure-JS tokenizer. Encode convention from model2vec/model.py: no
// special tokens, drop unk ids, mean-pool, L2-normalize.
export async function staticProvider(model: string): Promise<EmbedProvider> {
  let dir: string;
  let languages: string[] | undefined;
  if (isDownloadable(model)) {
    // Naming a HF id is consent: fetch whatever is missing now, announcing it on stderr.
    dir = await downloadModel(model, (file, into) => console.error(`sense: fetching ${model}/${file} into ${into}`));
    // Cached beside the repo; a local model directory has no card to read, so it has none.
    const cached = readLanguages(model);
    languages = cached && cached.length > 0 ? cached : undefined;
  } else {
    dir = modelDir(model);
    for (const file of MODEL_FILES) {
      if (!existsSync(join(dir, file))) {
        throw new SenseError('EMBED_MODEL_MISSING', `embed model ${model} is not available (looked in ${dir}); expected ${MODEL_FILENAMES} in that directory`);
      }
    }
  }

  const raw = readFileSync(join(dir, 'model.safetensors'));
  const headerLen = Number(raw.readBigUInt64LE(0));
  const header = JSON.parse(raw.subarray(8, 8 + headerLen).toString('utf8')) as Record<string, { dtype: string; shape: number[]; data_offsets: number[] }>;
  const entry = Object.entries(header).find(([k]) => k !== '__metadata__');
  if (!entry || entry[1].dtype !== 'F32') throw new SenseError('EMBED_MODEL', `${model}: expected an F32 safetensors matrix`);
  const spec = entry[1];
  const dims = spec.shape[1];
  const dataStart = raw.byteOffset + 8 + headerLen + spec.data_offsets[0];
  const matrix = dataStart % 4 === 0 ? new Float32Array(raw.buffer, dataStart, spec.shape[0] * dims) : new Float32Array(raw.buffer.slice(dataStart, dataStart + spec.shape[0] * dims * 4));

  const tokenizerJson = JSON.parse(readFileSync(join(dir, 'tokenizer.json'), 'utf8'));
  // Lazy import: the tokenizer loads only on the semantic path, never at CLI startup.
  const { Tokenizer } = await import('@huggingface/tokenizers');
  const tok = new Tokenizer(tokenizerJson, {});
  const unkId = tokenizerJson.model?.vocab?.[tokenizerJson.model?.unk_token] ?? -1;

  function one(text: string): Float32Array {
    // The tokenizer yields undefined (not the unk id) for tokens outside the vocab; an
    // undefined id would index the matrix at NaN and poison the whole mean-pool -- and the
    // int8 conversion then stores the NaN vector as all zeros, silently. Keep integers only.
    const ids = (tok.encode(text, { add_special_tokens: false }).ids as number[]).filter((id) => Number.isInteger(id) && id !== unkId);
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

  // Symmetric model: document and query embedding are the same call.
  return { id: `static:${model}`, dims, batchCap: BATCH_CAP, languages, embedDocuments: async (texts) => texts.map(one), embedQuery: async (text) => one(text) };
}
