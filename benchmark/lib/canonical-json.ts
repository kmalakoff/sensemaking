// Deterministic JSON for benchmark cache and identity keys. Arrays retain order; object keys sort
// recursively. Keep the encoding stable because existing synthetic cache directory names use it.
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function canonicalJson(value: JsonValue): string;
export function canonicalJson(value: Record<string, unknown> | readonly unknown[]): string;
export function canonicalJson(value: unknown): string | undefined;
export function canonicalJson(value: unknown): string | undefined {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
