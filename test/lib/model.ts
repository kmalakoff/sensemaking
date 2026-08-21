import { DEFAULT_EMBED_MODEL } from '../../src/config.ts';
import { downloadModel, hasModelFiles } from '../../src/features/embed.ts';

// Provisions the model the way a user runs `sense download`, reusing a warm cache. Most tests
// want writeModel()'s synthetic fixture instead; use this only to assert on the real model.
export async function ensureModel(model: string = DEFAULT_EMBED_MODEL): Promise<string> {
  if (!hasModelFiles(model)) {
    await downloadModel(model, (file, dir) => console.error(`test setup: fetching ${model}/${file} into ${dir} (once per machine)`));
  }
  return model;
}
