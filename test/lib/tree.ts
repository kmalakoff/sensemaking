import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Config, Preset } from 'sensemaking';
import { open } from 'sensemaking';

// Throwaway markdown trees for unit tests.

export function tmpTree(): string {
  return mkdtempSync(join(tmpdir(), 'sense-test-'));
}

export interface NoteSpec {
  frontmatter?: Record<string, unknown>;
  body?: string;
}

export function writeNote(baseDir: string, relPath: string, { frontmatter = {}, body = 'body' }: NoteSpec = {}): void {
  const lines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  mkdirSync(dirname(join(baseDir, relPath)), { recursive: true });
  writeFileSync(join(baseDir, relPath), `---\n${lines.join('\n')}\n---\n\n${body}\n`);
}

// v4 makes the `embed` block the whole vector switch, so a tree without one has no vectors
// and never reaches the model. That is what a bare call gives you. Tests that want vectors
// pass an `embed` block pointing at a local fixture model (see embed.test.ts).
export function openTree(baseDir: string, features?: Config['features'], presets?: Record<string, Preset>) {
  return open({ presets: presets ?? { default: { include: ['**/*.md'] } }, queries: {}, features, baseDir, configPath: null });
}

// For tests that need config beyond features/presets (embed provider settings, queries).
export function openConfig(cfg: Parameters<typeof open>[0]) {
  return open(cfg);
}
