// Whether a timing-sensitive step may start. A busy machine reads as up to a 3x regression on
// wall-time rows, so the limit is checked rather than assumed. Pure, so it needs no live machine.
import { spawnSync } from 'node:child_process';

export function quietMachineCheck(load1, cores) {
  const limit = cores / 2;
  if (load1 <= limit) return { blocked: false, message: null };
  return {
    blocked: true,
    message: `load average ${load1.toFixed(2)} exceeds the quiet-machine limit (${limit.toFixed(1)}, half of ${cores} cores).`,
  };
}

// A macOS/Linux system path: worth naming in a report, but not something to tell anyone to kill.
const SYSTEM_PREFIXES = ['/System/', '/usr/libexec/', '/usr/sbin/', '/sbin/', '/usr/lib/'];

/**
 * `ps -Ao pcpu,comm -r` output into the busiest processes. Parsed apart from the spawn so the
 * formatting is testable without a live machine.
 * @returns {Array<{ percent: number, command: string, system: boolean }>}
 */
export function parseTopProcesses(stdout, { limit = 6, minPercent = 5 } = {}) {
  return stdout
    .split('\n')
    .slice(1)
    .map((line) => line.trim().match(/^([\d.]+)\s+(.+)$/))
    .filter((m) => m && Number(m[1]) >= minPercent)
    .slice(0, limit)
    .map((m) => ({ percent: Number(m[1]), command: m[2], system: SYSTEM_PREFIXES.some((p) => m[2].startsWith(p)) }));
}

export function topProcesses(options) {
  const r = spawnSync('ps', ['-Ao', 'pcpu,comm', '-r'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout ? parseTopProcesses(r.stdout, options) : [];
}

/**
 * Names what is running so a reader can act, and separates what they can stop from what they
 * cannot: a run blocked by daemons alone needs a different decision than one blocked by a build.
 * @param {Array<{ percent: number, command: string, system: boolean }>} processes
 */
export function describeLoad(load1, cores, processes) {
  const { blocked, message } = quietMachineCheck(load1, cores);
  const lines = [message ?? `load average ${load1.toFixed(2)} is within the quiet-machine limit (${(cores / 2).toFixed(1)}, half of ${cores} cores).`];
  if (processes.length > 0) {
    lines.push('busiest processes:');
    for (const p of processes) lines.push(`  ${p.percent.toFixed(1).padStart(5)}%  ${p.command}${p.system ? '  (system, not yours to stop)' : ''}`);
    const yours = processes.filter((p) => !p.system);
    if (blocked) lines.push(yours.length > 0 ? `stop these and run again: ${yours.map((p) => p.command.split('/').pop()).join(', ')}` : "nothing here is yours to stop; this is the machine's own baseline, so wait rather than hunting for a process.");
  }
  return { blocked, text: lines.join('\n') };
}
