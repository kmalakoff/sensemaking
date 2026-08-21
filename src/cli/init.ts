import { initConfig } from '../config.ts';
import { USAGE } from './index.ts';
import { parse } from './shared.ts';
import type { Command } from './types.ts';

const init: Command = (ctx) => {
  parse(ctx.argv, `usage: ${ctx.name} ${USAGE.init}`, {});
  const configPath = initConfig(process.cwd());
  console.log(`created ${configPath}`);
  console.log(`query away: ${ctx.name} sql "SELECT path FROM frontmatter LIMIT 10"`);
  // Semantic search needs a 124 MB model that nothing downloads implicitly; name the step
  // here so the first search meets it as a choice rather than as a degraded result.
  console.log(`for meaning-based search: ${ctx.name} download (one 124 MB model, once)`);
  // The decisions a new tree faces -- features, frontmatter conventions, note size -- are not
  // in this output; name both places that hold them, since an agent may have neither.
  console.log('features and tree design: the sense-setup skill, or schema.json');
};
export default init;
