// Shared --out mechanics for every measurement script: a machine-readable artifact alongside
// the human-readable stdout table, never a replacement for it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function writeOut(outPath, data) {
  if (!outPath) return;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(data, null, 2)}\n`);
}
