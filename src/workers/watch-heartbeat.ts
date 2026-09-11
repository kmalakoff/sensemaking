import { parentPort, workerData } from 'node:worker_threads';
import { SenseError } from '../errors.ts';
import { serializeError } from '../scan/worker-error.ts';
import { WatchClaimDatabase, type WatchClaimWorkerData, type WatchClaimWorkerMessage } from '../watch-claim.ts';

function requireParentPort() {
  const port = parentPort;
  if (!port) throw new Error('watch heartbeat worker requires a parent port');
  return port;
}

const port = requireParentPort();
const data = workerData as WatchClaimWorkerData;
let database: WatchClaimDatabase | undefined;
let timer: NodeJS.Timeout | undefined;
let stopping = false;
let renewing = Promise.resolve();

function send(message: WatchClaimWorkerMessage): void {
  port.postMessage(message);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function closeDatabase(): Error | undefined {
  if (timer) clearInterval(timer);
  timer = undefined;
  try {
    database?.close();
    database = undefined;
    return undefined;
  } catch (err) {
    return asError(err);
  }
}

function addFailure(primary: Error, secondary: Error | undefined, message: string): Error {
  return secondary ? new AggregateError([primary, secondary], message) : primary;
}

function fail(err: unknown): void {
  if (stopping) return;
  stopping = true;
  let failure = asError(err);
  try {
    database?.release(data.token);
  } catch (releaseError) {
    failure = addFailure(failure, asError(releaseError), 'watch heartbeat and claim release both failed');
  }
  const closeError = closeDatabase();
  failure = addFailure(failure, closeError, 'watch heartbeat and database cleanup both failed');
  try {
    send({ type: 'failure', error: serializeError(failure) });
  } finally {
    port.close();
  }
}

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (timer) clearInterval(timer);
  let failure: Error | undefined;
  try {
    await renewing;
    if (!database?.release(data.token)) throw new SenseError('WATCH_ACTIVE', 'watch ownership was replaced by another watcher');
  } catch (err) {
    failure = asError(err);
  } finally {
    const closeError = closeDatabase();
    if (closeError) failure = failure ? addFailure(failure, closeError, 'watch heartbeat shutdown and database cleanup both failed') : closeError;
    try {
      if (failure) send({ type: 'failure', error: serializeError(failure) });
      else send({ type: 'stopped' });
    } finally {
      port.close();
    }
  }
}

async function main(): Promise<void> {
  try {
    database = new WatchClaimDatabase(data.configDir);
    await database.acquire(data.token, data.pid, data.force);
    send({ type: 'acquired' });
    timer = setInterval(() => {
      if (stopping) return;
      renewing = renewing.then(() => {
        if (!database?.renew(data.token)) throw new SenseError('WATCH_ACTIVE', 'watch ownership was replaced by another watcher');
      });
      renewing.catch(fail);
    }, data.heartbeatIntervalMs);
    port.on('message', (message: { type?: string }) => {
      if (message.type === 'stop') void stop();
    });
  } catch (err) {
    fail(err);
  }
}

void main();
