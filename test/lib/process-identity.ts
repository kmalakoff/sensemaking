// A process's identity for test containment: pid plus its OS start time and command line, read with
// POSIX `ps -o stat=,lstart=,command= -p <pid>`. A pid alone can be reused; a containment step signals
// a pid only after re-reading the identity and finding it unchanged. Where `ps` is unavailable or
// unreadable (Windows) the identity is unknown: unknown is never signalled and never taken as
// evidence that a process ended.
import { spawnSync } from 'node:child_process';

export interface ProcessIdentity {
  pid: number;
  start: string;
  command: string;
}

interface Observed extends ProcessIdentity {
  // ps state; a leading Z is a zombie: it has terminated and only awaits its parent's reap
  stat: string;
}

export type IdentityCheck = 'same' | 'zombie' | 'gone' | 'different' | 'unknown';

// stat is one field and lstart five ("Sat Oct 11 14:03:02 2026") on macOS and Linux; the command follows.
function observe(pid: number): Observed | 'gone' | 'unknown' {
  const listed = spawnSync('ps', ['-o', 'stat=,lstart=,command=', '-p', String(pid)], { encoding: 'utf8' });
  if (listed.error) return 'unknown';
  const line = listed.stdout.split('\n').find((row) => row.trim().length > 0);
  if (!line) return listed.status === 1 ? 'gone' : 'unknown';
  if (listed.status !== 0) return 'unknown';
  const fields = line.trim().split(/\s+/);
  if (fields.length < 7) return 'unknown';
  return { pid, stat: fields[0] as string, start: fields.slice(1, 6).join(' '), command: fields.slice(6).join(' ') };
}

export function readIdentity(pid: number): ProcessIdentity | 'gone' | 'unknown' {
  const now = observe(pid);
  if (typeof now !== 'object') return now;
  if (now.stat.startsWith('Z')) return 'gone';
  return { pid, start: now.start, command: now.command };
}

// A zombie keeps its start time but not its command line on every ps, so it is matched by start
// time alone: the pid cannot have been reused while the zombie exists.
function checkIdentity(recorded: ProcessIdentity): IdentityCheck {
  const now = observe(recorded.pid);
  if (now === 'gone' || now === 'unknown') return now;
  if (now.start !== recorded.start) return 'different';
  if (now.stat.startsWith('Z')) return 'zombie';
  return now.command === recorded.command ? 'same' : 'different';
}

export type Containment = { pid: number; outcome: 'gone-before' | 'killed' | 'survived' | 'different-process' | 'identity-unknown' | 'termination-unverified' | 'signal-failed'; detail?: string };

// Kill a recorded process only if it is still that process, then wait until termination is verified:
// gone, a zombie of it, or its pid now naming a different process. Never throws for an ordinary
// outcome, never signals a mismatched or unknown pid, and never claims an unverified termination.
export async function killVerified(recorded: ProcessIdentity, boundMs: number): Promise<Containment> {
  const check = checkIdentity(recorded);
  if (check === 'gone' || check === 'zombie') return { pid: recorded.pid, outcome: 'gone-before' };
  if (check === 'different') return { pid: recorded.pid, outcome: 'different-process' };
  if (check === 'unknown') return { pid: recorded.pid, outcome: 'identity-unknown' };
  try {
    process.kill(recorded.pid, 'SIGKILL');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return { pid: recorded.pid, outcome: 'gone-before' };
    return { pid: recorded.pid, outcome: 'signal-failed', detail: `${code ?? ''} ${(err as Error).message}`.trim() };
  }
  const until = Date.now() + boundMs;
  for (;;) {
    const after = checkIdentity(recorded);
    if (after === 'gone' || after === 'zombie' || after === 'different') return { pid: recorded.pid, outcome: 'killed', detail: after };
    if (after === 'unknown') return { pid: recorded.pid, outcome: 'termination-unverified', detail: 'SIGKILL sent; ps could not confirm the process ended' };
    if (Date.now() >= until) return { pid: recorded.pid, outcome: 'survived' };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
