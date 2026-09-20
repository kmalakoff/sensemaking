const pending = new WeakMap<object, Promise<void>>();

// High-level queries share temporary tables and transaction state on a handle.
// Raw SQL and handle closure remain caller-owned and must await these queries.
export function serialQuery<T>(handle: object, query: () => Promise<T>): Promise<T> {
  const result = (pending.get(handle) ?? Promise.resolve()).then(query);
  const settled = result.then(
    () => {},
    () => {}
  );
  pending.set(handle, settled);
  void settled.then(() => {
    if (pending.get(handle) === settled) pending.delete(handle);
  });
  return result;
}
