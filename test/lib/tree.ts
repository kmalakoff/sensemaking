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
  // An object is JSON-serialized per key, which is the convenient form for tests that only
  // need well-formed frontmatter. A string is written verbatim, which is the only way to
  // express the malformed YAML the parse-policy tests are about.
  frontmatter?: Record<string, unknown> | string;
  body?: string;
}

export function writeNote(baseDir: string, relPath: string, { frontmatter = {}, body = 'body' }: NoteSpec = {}): void {
  const fm =
    typeof frontmatter === 'string'
      ? frontmatter
      : Object.entries(frontmatter)
          .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
          .join('\n');
  mkdirSync(dirname(join(baseDir, relPath)), { recursive: true });
  writeFileSync(join(baseDir, relPath), `---\n${fm}\n---\n\n${body}\n`);
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
