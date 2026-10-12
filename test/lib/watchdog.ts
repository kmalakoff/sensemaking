// A test's own bound on an operation that has no bound of its own (the benchmark's observer and
// watcher waits end only on an event, an error, the child's exit, or a caller's cancellation). On
// expiry the test stops what it owns through `stop`, which must make the operation settle: an owned
// job's fail, a watcher's kill, an AbortController's abort. The test then waits for that settlement
// under the same bound and, if it still has not settled, reports that instead of waiting forever.
// Timers are always cleared; the primary expiry, any cleanup error and the operation's own late
// outcome are all kept.
export async function withinTest<T>(label: string, ms: number, operation: Promise<T>, stop: () => unknown): Promise<T> {
  const settled = operation.then(
    (value) => ({ ok: true as const, value }),
    (reason: unknown) => ({ ok: false as const, reason })
  );
  const first = await raceBound(settled, ms);
  if (first !== 'expired') {
    if (first.ok) return first.value;
    throw first.reason;
  }
  const expiry = new Error(`${label} did not settle within ${ms}ms`);
  let cleanupError: unknown = null;
  try {
    await stop();
  } catch (err) {
    cleanupError = err;
  }
  const late = await raceBound(settled, ms);
  const errors: unknown[] = [expiry];
  if (cleanupError) errors.push(cleanupError);
  if (late === 'expired') errors.push(new Error(`${label} still had not settled ${ms}ms after it was stopped`));
  else if (!late.ok) errors.push(late.reason);
  throw errors.length === 1 ? expiry : new AggregateError(errors, `${expiry.message}${cleanupError ? '; cleanup failed' : ''}${late === 'expired' ? '; stop did not settle it' : ''}`);
}

async function raceBound<T>(promise: Promise<T>, ms: number): Promise<T | 'expired'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<'expired'>((resolveExpired) => (timer = setTimeout(() => resolveExpired('expired'), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

// The same bound for an operation cancelled through an AbortSignal (the benchmark's native observer):
// on expiry the test aborts its own controller, which cancels the owned job and settles the call.
export function abortableWithin<T>(label: string, ms: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  return withinTest(label, ms, operation(controller.signal), () => controller.abort(new Error(`${label} exceeded the test watchdog`)));
}
