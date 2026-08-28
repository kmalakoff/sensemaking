import { basename } from 'node:path';
import { embedConfig } from '../config/index.ts';
import { downloadModel, isDownloadable, modelDir, modelPresent } from '../embed/store.ts';
import { SenseError } from '../errors.ts';
import { USAGE } from './index.ts';
import { CONFIG, parse } from './shared.ts';
import type { Command } from './types.ts';

// A prefetch over the store's own fetch path: a search would fetch the same weights
// lazily, so this only moves the wait earlier. Idempotent; asks nothing, so CI can run it unattended.
const download: Command = async (ctx) => {
  const { values } = parse(ctx.argv, `usage: ${ctx.name} ${USAGE.download}`, { ...CONFIG });
  const cfg = ctx.resolveConfig(values.config as string | undefined);
  const e = embedConfig(cfg);
  if (!e) throw new SenseError('EMBED_DISABLED', 'no preset asks for vectors, so there is no model to download');

  if (e.provider !== 'static') {
    console.log(`embed provider is "${e.provider}" (${e.url}), so there is nothing to download; ${ctx.name} search reaches it over the network`);
    return;
  }
  if (modelPresent(cfg)) {
    const at = isDownloadable(e.model) ? `@${basename(modelDir(e.model))} ` : ' ';
    console.log(`${e.model}${at}is already available in ${modelDir(e.model)}`);
    return;
  }
  const dir = await downloadModel(e.model, (file, into) => console.error(`fetching ${e.model}/${file} into ${into}`));
  console.log(`downloaded ${e.model}@${basename(dir)} into ${dir}`);
};
export default download;
