import { STATE_DIR } from '../config/types.ts';

export function shouldReconcileWatchNotification(filename: string | Buffer | null): boolean {
  return typeof filename !== 'string' || !filename.startsWith(STATE_DIR);
}
