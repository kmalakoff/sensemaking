import { initConfig } from '../config.ts';
import type { Command } from './types.ts';

const init: Command = (ctx) => {
  const configPath = initConfig(process.cwd());
  console.log(`created ${configPath}`);
  console.log(`query away: ${ctx.name} query "SELECT path FROM frontmatter LIMIT 10"`);
  // The decisions a new tree faces -- features, frontmatter conventions, note size -- are not
  // in this output; name both places that hold them, since an agent may have neither.
  console.log('features and tree design: the sense-setup skill, or schema.json');
};
export default init;
