// Long-work progress on stderr only: stdout stays the parseable answer, so progress can
// never corrupt --format json (the same channel warnings already use). TTY-aware: a human
// terminal gets one self-overwriting line; a non-TTY consumer (agent, pipe, CI) gets at
// most a few append-only lines -- an agent transcript gains lines, not redraw frames.

const NON_TTY_MILESTONES = 4;

export interface Progress {
  tick(done: number): void;
  finish(): void;
}

// `total` known upfront; `label` names the work ("embedding notes", "reparsing files").
// Silent entirely below `threshold` -- short work needs no narration.
export function progress(label: string, total: number, threshold = 200): Progress {
  if (total < threshold) return { tick() {}, finish() {} };

  const started = Date.now();
  const isTTY = process.stderr.isTTY === true;
  let lastShown = 0;
  let wrote = false;

  const line = (done: number) => {
    const elapsed = (Date.now() - started) / 1000;
    // Estimate from observed rate, only once there is a rate to observe.
    const eta = done > 0 && done < total ? `, ~${Math.max(1, Math.round((elapsed / done) * (total - done)))}s left` : '';
    return `${label}: ${done}/${total}${eta}`;
  };

  return {
    tick(done: number) {
      if (isTTY) {
        process.stderr.write(`\r${line(done)}`);
        wrote = true;
        return;
      }
      // Sparse milestones: first tick, then every 1/NON_TTY_MILESTONES of the total.
      if (done === lastShown) return;
      if (lastShown === 0 || done - lastShown >= total / NON_TTY_MILESTONES) {
        process.stderr.write(`${line(done)}\n`);
        lastShown = done;
        wrote = true;
      }
    },
    finish() {
      if (!wrote) return;
      if (isTTY) process.stderr.write(`\r${line(total)}\n`);
      else if (lastShown < total) process.stderr.write(`${line(total)}\n`);
    },
  };
}
