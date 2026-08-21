import { embedConfig } from '../config.ts';
import { SenseError } from '../errors.ts';
import { downloadModel, modelDir, modelPresent } from '../features/embed.ts';
import { USAGE } from './index.ts';
import { CONFIG, parse } from './shared.ts';
import type { Command } from './types.ts';

// The one command that fetches weights. Nothing else touches the network for them, so a
// query that reads like a query never spends minutes pulling 124 MB. Asks nothing, so there
// is no prompt for CI to bypass; running it twice is a no-op.
const download: Command = async (ctx) => {
  const { values } = parse(ctx.argv, `usage: ${ctx.name} ${USAGE.download}`, { ...CONFIG });
  const cfg = ctx.resolveConfig(values.config as string | undefined);
  const e = embedConfig(cfg);
  if (!e) throw new SenseError('EMBED_DISABLED', 'no preset asks for vectors, so there is no model to download');

  if (e.type === 'api') {
    console.log(`embed type is "api" (${e.url}), so there is nothing to download; ${ctx.name} search reaches it over the network`);
    return;
  }
  if (modelPresent(cfg)) {
    console.log(`${e.model} is already available in ${modelDir(e.model)}`);
    return;
  }
  const dir = await downloadModel(e.model, (file, into) => console.error(`fetching ${e.model}/${file} into ${into}`));
  console.log(`downloaded ${e.model} into ${dir}`);
};
export default download;
