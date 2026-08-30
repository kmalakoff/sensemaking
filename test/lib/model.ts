import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { refsMainPath, snapshotDir, writeLanguages, writeRef } from '../../src/embed/store.ts';
import { scratchDir } from './scratch.ts';

const DIMS = 8;

// apple ≡ pomme, stone its own: a vector match exists exactly where FTS5 has zero term overlap.
// Tokens within a group share a vector, different groups get orthogonal ones.
const DEFAULT_GROUPS: string[][] = [['apple', 'pomme'], ['stone']];

// Local Model2Vec fixture: WordLevel vocab, 8-dim f32 matrix.
function writeModelFiles(dir: string, groups: string[][] = DEFAULT_GROUPS): void {
  const vocab: Record<string, number> = { '[UNK]': 0 };
  const rows: number[][] = [new Array(DIMS).fill(0)];
  groups.forEach((group, gi) => {
    const vec = new Array(DIMS).fill(0);
    vec[gi % DIMS] = 1;
    for (const token of group) {
      vocab[token] = rows.length;
      rows.push(vec);
    }
  });
  writeFileSync(
    join(dir, 'tokenizer.json'),
    JSON.stringify({
      version: '1.0',
      truncation: null,
      padding: null,
      added_tokens: [],
      normalizer: { type: 'Lowercase' },
      pre_tokenizer: { type: 'WhitespaceSplit' },
      post_processor: null,
      decoder: null,
      model: { type: 'WordLevel', vocab, unk_token: '[UNK]' },
    })
  );
  const data = new Float32Array(rows.flat());
  const header = Buffer.from(JSON.stringify({ embeddings: { dtype: 'F32', shape: [rows.length, DIMS], data_offsets: [0, data.byteLength] } }));
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(header.length));
  writeFileSync(join(dir, 'model.safetensors'), Buffer.concat([len, header, Buffer.from(data.buffer)]));
}

export function writeModel(groups?: string[][]): string {
  const dir = scratchDir('model');
  writeModelFiles(dir, groups);
  return dir;
}

// One HF-cache-shaped root for every suite in this run, disposable with the rest of .tmp/test:
// fixture model ids resolve here instead of the real ~/.sense/models.
let modelsRoot: string | undefined;
export function testModelsRoot(): string {
  if (!modelsRoot) modelsRoot = scratchDir('models-root');
  return modelsRoot;
}

// A disposable HF-style cache entry under testModelsRoot(), never the machine cache: fixture files
// at snapshots/<sha>, refs/main pointing at it, optionally a languages.json. Returns the repo dir.
export function seedModelCache(model: string, sha: string, opts: { groups?: string[][]; languages?: string[] } = {}): string {
  const root = testModelsRoot();
  const dir = snapshotDir(model, sha, root);
  mkdirSync(dir, { recursive: true });
  writeModelFiles(dir, opts.groups);
  writeRef(model, sha, root);
  if (opts.languages) writeLanguages(model, opts.languages, root);
  return dirname(dirname(refsMainPath(model, root)));
}
