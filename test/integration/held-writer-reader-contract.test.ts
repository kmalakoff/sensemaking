import assert from 'node:assert';
import { type ChildProcess, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { signalProcessTree } from '../../benchmark/lib/native-observer.mjs';
import { packageRoot, scratchDir } from '../lib/scratch.ts';
import { forEachStore, type ParityStoreName, withTreeForStore } from '../lib/stores.ts';
import { writeNote } from '../lib/tree.ts';

const DEADLINE_MS = 30_000;

const CHILD = String.raw`
import { channel } from 'node:diagnostics_channel';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const role = process.argv[1];
const configPath = process.argv[2];
const packageRoot = process.argv[3];
const api = await import(pathToFileURL(join(packageRoot, 'dist', 'esm', 'index.js')).href);
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const lockWait = channel('sensemaking.store.lock-wait');
const onLockWait = ({ store }) => send({ type: 'lock-observed', store });
if (role === 'reader') lockWait.subscribe(onLockWait);
const input = createInterface({ input: process.stdin });
const command = () => new Promise((resolve, reject) => {
  const onLine = (line) => {
    cleanup();
    try { resolve(JSON.parse(line)); } catch (err) { reject(err); }
  };
  const onClose = () => { cleanup(); reject(new Error('parent closed protocol input')); };
  const cleanup = () => {
    input.off('line', onLine);
    input.off('close', onClose);
  };
  input.once('line', onLine);
  input.once('close', onClose);
});

try {
  const cfg = api.loadConfig(configPath);
  if (role === 'writer') {
    const opened = await api.open(cfg);
    try {
      await opened.store.transaction(async () => {
        const update = await opened.store.prepare('UPDATE content SET text = ? WHERE "path" = ?');
        await update.run('committed-a', 'a.md');
        await update.run('committed-b', 'b.md');
        send({ type: 'held' });
        const release = await command();
        if (release?.type !== 'release') throw new Error('writer expected release command');
      });
      send({ type: 'committed' });
    } finally {
      await opened.store.close();
    }
    send({ type: 'done' });
  } else if (role === 'reader') {
    send({ type: 'ready' });
    const go = await command();
    if (go?.type !== 'go') throw new Error('reader expected go command');
    send({ type: 'attempting' });
    const opening = api.open(cfg);
    send({ type: 'open-launched' });
    const opened = await opening;
    try {
      send({ type: 'open-ready' });
      const probe = await command();
      if (probe?.type !== 'probe') throw new Error('reader expected probe command');
      const rows = await (await opened.store.prepare('SELECT "path", text FROM content WHERE "path" IN (?, ?) ORDER BY "path"')).all('a.md', 'b.md');
      send({ type: 'read-before-release', rows });
      const release = await command();
      if (release?.type !== 'release') throw new Error('reader expected release command');
      const fresh = await (await opened.store.prepare('SELECT "path", text FROM content WHERE "path" IN (?, ?) ORDER BY "path"')).all('a.md', 'b.md');
      send({ type: 'read', rows: fresh });
    } finally {
      await opened.store.close();
    }
    send({ type: 'done' });
  } else {
    throw new Error('unknown child role');
  }
} catch (err) {
  send({ type: 'error', message: err?.stack ?? String(err) });
  process.exitCode = 1;
} finally {
  lockWait.unsubscribe(onLockWait);
  input.close();
}
`;

interface Message {
  type: string;
  store?: string;
  rows?: Array<{ path: string; text: string }>;
  message?: string;
}

interface ProtocolChild {
  child: ChildProcess;
  messages: Message[];
  stderr: string;
  waitFor(type: string): Promise<Message>;
  send(message: object): void;
  closed: Promise<void>;
}

interface Waiter {
  resolve: (message: Message) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
  close?: () => void;
}

function startChild(role: 'writer' | 'reader', configPath: string): ProtocolChild {
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD, role, configPath, packageRoot], {
    cwd: packageRoot,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages: Message[] = [];
  let stdout = '';
  let stderr = '';
  let failure: Error | undefined;
  const waiters = new Map<string, Waiter[]>();
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const fail = (err: Error): void => {
    failure ??= err;
    const pending = [...waiters.values()].flat();
    waiters.clear();
    for (const waiter of pending) waiter.reject(failure);
  };
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    for (;;) {
      const newline = stdout.indexOf('\n');
      if (newline < 0) break;
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      try {
        const message = JSON.parse(line) as Message;
        messages.push(message);
        if (message.type === 'error') {
          fail(new Error(`child protocol error: ${message.message ?? 'unknown child error'}`));
          return;
        }
        for (const waiter of waiters.get(message.type) ?? []) waiter.resolve(message);
        waiters.delete(message.type);
      } catch (err) {
        fail(new Error(`child returned malformed protocol: ${line}`, { cause: err }));
      }
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on('error', (err) => {
    fail(new Error(`child process error: ${err.message}`, { cause: err }));
  });
  const waitFor = (type: string): Promise<Message> => {
    const found = messages.find((message) => message.type === type);
    if (found) return Promise.resolve(found);
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      let waiter: Waiter;
      const cleanup = (): void => {
        if (waiter.timer) clearTimeout(waiter.timer);
        if (waiter.close) child.off('close', waiter.close);
        const pending = waiters.get(type);
        if (!pending) return;
        const index = pending.indexOf(waiter);
        if (index >= 0) pending.splice(index, 1);
        if (pending.length === 0) waiters.delete(type);
      };
      waiter = {
        resolve: (message) => {
          cleanup();
          resolve(message);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      };
      waiter.timer = setTimeout(() => waiter.reject(new Error(`child produced no ${type} within ${DEADLINE_MS}ms; stderr=${stderr || 'none'}`)), DEADLINE_MS);
      waiter.close = () => waiter.reject(new Error(`child exited before ${type}: ${child.signalCode ?? child.exitCode}; stderr=${stderr || 'none'}`));
      const list = waiters.get(type) ?? [];
      list.push(waiter);
      waiters.set(type, list);
      child.once('close', waiter.close);
    });
  };
  const send = (message: object): void => {
    child.stdin?.write(`${JSON.stringify(message)}\n`);
  };
  return {
    child,
    messages,
    get stderr() {
      return stderr;
    },
    waitFor,
    send,
    closed,
  };
}

async function closeChild(process: ProtocolChild): Promise<void> {
  process.child.stdin?.end();
  await process.closed;
}

async function killChild(process: ProtocolChild | undefined): Promise<void> {
  if (!process) return;
  if (process.child.pid !== undefined && process.child.exitCode === null && process.child.signalCode === null) signalProcessTree(process.child, 'SIGKILL');
  await process.closed;
}

async function runOverlap(store: ParityStoreName): Promise<void> {
  const baseDir = scratchDir(`held-reader-${store}`);
  const configPath = join(baseDir, 'sense.config.json');
  writeFileSync(configPath, JSON.stringify({ version: 5, store, presets: { default: { include: ['**/*.md'] } }, queries: {} }));
  writeNote(baseDir, 'a.md', { body: 'old-a' });
  writeNote(baseDir, 'b.md', { body: 'old-b' });

  await withTreeForStore(store, baseDir, async ({ store: opened }) => {
    const baseline = await (await opened.prepare('SELECT "path", text FROM content WHERE "path" IN (?, ?) ORDER BY "path"')).all('a.md', 'b.md');
    assert.deepEqual(
      baseline,
      [
        { path: 'a.md', text: 'old-a' },
        { path: 'b.md', text: 'old-b' },
      ],
      `${store}: baseline`
    );
  });

  let writer: ProtocolChild | undefined;
  let reader: ProtocolChild | undefined;
  try {
    if (store === 'sqlite') {
      reader = startChild('reader', configPath);
      await reader.waitFor('ready');
      reader.send({ type: 'go' });
      await reader.waitFor('attempting');
      await reader.waitFor('open-launched');
      await reader.waitFor('open-ready');
      writer = startChild('writer', configPath);
      await writer.waitFor('held');
      reader.send({ type: 'probe' });
      const beforeRelease = await reader.waitFor('read-before-release');
      assert.deepEqual(
        beforeRelease.rows,
        [
          { path: 'a.md', text: 'old-a' },
          { path: 'b.md', text: 'old-b' },
        ],
        `${store}: reader must see the last committed snapshot while writer is held`
      );
    } else {
      writer = startChild('writer', configPath);
      reader = startChild('reader', configPath);
      await writer.waitFor('held');
      await reader.waitFor('ready');
      reader.send({ type: 'go' });
      await reader.waitFor('attempting');
      await reader.waitFor('open-launched');
      const locked = await reader.waitFor('lock-observed');
      assert.equal(locked.store, store, 'the real public open must encounter the held native lock');
      assert.equal(
        reader.messages.some((message) => message.type === 'open-ready'),
        false
      );
      assert.equal(
        writer.messages.some((message) => message.type === 'committed'),
        false
      );
    }
    assert.ok(writer && reader, `${store}: child processes must be started`);
    let beforeRelease: Message | undefined;
    if (store !== 'sqlite') {
      writer.send({ type: 'release' });
      await writer.waitFor('committed');
      await reader.waitFor('open-ready');
      reader.send({ type: 'probe' });
      beforeRelease = await reader.waitFor('read-before-release');
    } else {
      writer.send({ type: 'release' });
      await writer.waitFor('committed');
    }
    if (beforeRelease)
      assert.deepEqual(
        beforeRelease.rows,
        [
          { path: 'a.md', text: 'committed-a' },
          { path: 'b.md', text: 'committed-b' },
        ],
        `${store}: a blocked reader must see the complete committed snapshot`
      );
    reader.send({ type: 'release' });
    const read = await reader.waitFor('read');
    assert.deepEqual(
      read.rows,
      [
        { path: 'a.md', text: 'committed-a' },
        { path: 'b.md', text: 'committed-b' },
      ],
      `${store}: reader must see one complete committed snapshot`
    );
    await writer.waitFor('done');
    await reader.waitFor('done');
    await closeChild(writer);
    await closeChild(reader);
  } catch (err) {
    const detail = [writer?.stderr, reader?.stderr].filter(Boolean).join('\n');
    throw new Error(`${store}: held-writer reader proof failed${detail ? `; stderr=${detail}` : ''}`, { cause: err });
  } finally {
    await Promise.all([killChild(writer), killChild(reader)]);
  }

  await withTreeForStore(store, baseDir, async ({ store: opened }) => {
    const fresh = await (await opened.prepare('SELECT "path", text FROM content WHERE "path" IN (?, ?) ORDER BY "path"')).all('a.md', 'b.md');
    assert.deepEqual(
      fresh,
      [
        { path: 'a.md', text: 'committed-a' },
        { path: 'b.md', text: 'committed-b' },
      ],
      `${store}: fresh public read after commit`
    );
  });
}

describe('held writer and independent reader', () => {
  it('never exposes partial state or a raw native lock failure', async function () {
    this.timeout(90_000);
    await forEachStore(runOverlap);
  });
});
