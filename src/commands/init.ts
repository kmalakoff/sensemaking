import { initConfig } from '../config.ts';
import type { Command } from './types.ts';

const init: Command = (ctx) => {
  const configPath = initConfig(process.cwd());
  console.log(`created ${configPath}`);
  console.log(`query away: ${ctx.name} query "SELECT path FROM frontmatter LIMIT 10"`);
};
export default init;
