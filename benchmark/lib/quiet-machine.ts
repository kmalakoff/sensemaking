// Load-average admission policy, independent of process diagnostics.
import { spawnSync } from 'node:child_process';

const DEFAULT_PROCESS_LIMIT = 6;
const DEFAULT_MIN_PROCESS_PERCENT = 5;

export function quietMachineCheck(load1: number, cores: number) {
  const limit = cores / 2;
  if (load1 <= limit) return { blocked: false, message: null };
  return {
    blocked: true,
    message: `load average ${load1.toFixed(2)} exceeds the quiet-machine limit (${limit.toFixed(1)}, half of ${cores} cores).`,
  };
}

// Parse reported CPU values and sort before truncating the sample.
export function parseTopProcesses(stdout: string, { limit = DEFAULT_PROCESS_LIMIT, minPercent = DEFAULT_MIN_PROCESS_PERCENT } = {}) {
  return stdout
    .split('\n')
    .slice(1)
    .map((line) => line.trim().match(/^([\d.]+)\s+(.+)$/))
    .filter((m) => m && Number(m[1]) >= minPercent)
    .map((m) => ({ percent: Number((m as RegExpMatchArray)[1]), command: (m as RegExpMatchArray)[2] }))
    .sort((a, b) => b.percent - a.percent)
    .slice(0, limit);
}

export function topProcesses({ limit = DEFAULT_PROCESS_LIMIT, minPercent = DEFAULT_MIN_PROCESS_PERCENT } = {}) {
  const r = spawnSync('ps', ['-Ao', 'pcpu,comm'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    const error = r.error?.message ?? (r.signal ? `ps terminated by signal ${r.signal}` : `ps exited with status ${r.status ?? 'unknown'}`);
    const stderr = r.stderr?.trim();
    return { processes: [], error: stderr ? `${error}: ${stderr}` : error, limit, minPercent };
  }
  return { processes: parseTopProcesses(r.stdout, { limit, minPercent }), error: null, limit, minPercent };
}

export function describeLoad(load1: number, cores: number, sample: ReturnType<typeof topProcesses>) {
  const { blocked, message } = quietMachineCheck(load1, cores);
  const lines = [message ?? `load average ${load1.toFixed(2)} is within the quiet-machine limit (${(cores / 2).toFixed(1)}, half of ${cores} cores).`];
  if (sample.error !== null) {
    lines.push(`process CPU sample unavailable: ${sample.error}`);
  } else {
    lines.push(`reported process CPU (up to ${sample.limit} entries at or above ${sample.minPercent}%):`);
    for (const p of sample.processes) lines.push(`  ${p.percent.toFixed(1).padStart(5)}%  ${p.command}`);
    if (sample.processes.length === 0) lines.push('  no processes are listed in this sample.');
  }
  return { blocked, text: lines.join('\n') };
}
