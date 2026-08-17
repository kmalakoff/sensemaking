import type { WatchEvent } from '../watch.ts';
import { runWatch } from '../watch.ts';
import { USAGE } from './index.ts';
import { CONFIG, parse, printWarnings } from './shared.ts';
import type { Command } from './types.ts';

const watch: Command = async (ctx) => {
  const { values } = parse(ctx.argv, `usage: ${ctx.name} ${USAGE.watch}`, { force: { type: 'boolean', default: false }, ...CONFIG });
  await runWatch(ctx.resolveConfig(values.config as string | undefined), {
    force: values.force as boolean,
    onEvent: (event: WatchEvent) => {
      if (event.type === 'started') {
        console.log(`${ctx.name} watch: watching ${event.baseDir}`);
        console.log(`${ctx.name} watch: db ${event.dbPath}`);
      } else if (event.type === 'reconciled') {
        printWarnings(event.warnings);
        if (event.parsed > 0) console.log(`${ctx.name} watch: reconciled, ${event.parsed} file(s) reparsed (${event.total} total)`);
      } else {
        console.error(`${ctx.name} watch: reconcile error: ${event.message}`);
      }
    },
  });
};
export default watch;
