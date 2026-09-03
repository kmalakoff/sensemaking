// Whether a timing-sensitive step may start. A busy machine reads as up to a 3x regression on
// wall-time rows, so the limit is checked rather than assumed, and there is no override: a blocked
// run costs nothing now that resuming is the default, while a measurement taken anyway is a number
// nobody can trust. Pure function of its inputs, so it needs no live machine to test.
export function quietMachineCheck(load1, cores) {
  const limit = cores / 2;
  if (load1 <= limit) return { blocked: false, message: null };
  return {
    blocked: true,
    message: `load average ${load1.toFixed(2)} exceeds the quiet-machine limit (${limit.toFixed(1)}, half of ${cores} cores). Stop whatever else is running on this machine (another benchmark, a build, a test suite) and run again; the sitting resumes where it stopped.`,
  };
}
