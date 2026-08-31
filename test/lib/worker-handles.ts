// MessagePorts held by live pool threads. Measured 2026-08-30: a pool reports one per thread while
// constructed or dispatching, and drops to zero once idle, so this only reads nonzero mid-flight.
export function liveWorkerHandles(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === 'MessagePort').length;
}
