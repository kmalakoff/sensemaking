// Whether a timing-sensitive step may start. PLAN.md 3.10 / 2026-09-01: a busy machine reads as
// up to a 3x regression on wall-time rows, so the limit is checked, not assumed. Pure function of
// its inputs (load1, cores read by the caller) so it needs no live machine to test, and so a later
// stage boundary can call it the same way without depending on release.mjs's step loop.
export function quietMachineCheck(load1, cores, allowBusy) {
  const limit = cores / 2;
  if (load1 <= limit) return { blocked: false, message: null };
  if (allowBusy) {
    return {
      blocked: false,
      message: `WARNING: load average ${load1.toFixed(2)} exceeds the quiet-machine limit (${limit.toFixed(1)}, half of ${cores} cores); continuing because --allow-busy was passed. Timing numbers from this step may be inflated by machine contention.`,
    };
  }
  return {
    blocked: true,
    message: `load average ${load1.toFixed(2)} exceeds the quiet-machine limit (${limit.toFixed(1)}, half of ${cores} cores). Stop whatever else is running on this machine (another benchmark, a build, a test suite) and retry, or pass --allow-busy to measure anyway.`,
  };
}
