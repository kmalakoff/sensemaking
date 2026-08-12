import type { WatchEvent } from '../watch.ts';
import { runWatch } from '../watch.ts';
import type { Command } from './types.ts';
import { printWarnings } from './vault.ts';

const watch: Command = async (ctx) => {
  await runWatch(ctx.resolveConfig(), {
    force: ctx.values.force,
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
