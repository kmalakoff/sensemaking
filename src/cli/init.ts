import { DEFAULT_EMBED_MODEL, initConfig } from '../config/index.ts';
import { USAGE } from './index.ts';
import { parse } from './shared.ts';
import type { Command } from './types.ts';

const init: Command = (ctx) => {
  const { values } = parse(ctx.argv, `usage: ${ctx.name} ${USAGE.init}`, {
    model: { type: 'string' },
    provider: { type: 'string' },
    url: { type: 'string' },
  });
  const modelFlag = values.model as string | undefined;
  const providerFlag = values.provider as string | undefined;
  const model = modelFlag ?? DEFAULT_EMBED_MODEL;
  const provider = providerFlag ?? 'static';
  const url = values.url as string | undefined;
  // An invalid --provider throws here (validateConfig's own shape error), before anything is
  // written -- one validator, not a second copy of its rules.
  const configPath = initConfig(process.cwd(), { model: modelFlag, provider: providerFlag, url });
  console.log(`created ${configPath}`);
  console.log(`query away: ${ctx.name} sql "SELECT path FROM frontmatter LIMIT 10"`);
  // Naming a model is consent to fetch it, so writing one into the config says so loudly,
  // with the download consequence and the prefetch command, right where it was just written.
  if (provider === 'static') {
    console.log(`embed model: ${model} (static); nothing downloads until the first vector search -- ${ctx.name} download fetches it now instead`);
  } else {
    console.log(`embed model: ${model} (${provider}${url ? ` at ${url}` : ''}); reached over the network at search time, nothing to download`);
  }
  console.log('a non-English tree should pick a model for its languages: see the sense-setup skill or INTEGRATIONS.md');
  // The decisions a new tree faces -- features, frontmatter conventions, note size -- are not
  // in this output; name both places that hold them, since an agent may have neither.
  console.log('features and tree design: the sense-setup skill, or schema.json');
};
export default init;
