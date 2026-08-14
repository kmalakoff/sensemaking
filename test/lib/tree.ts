import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import type { Config } from 'sensemaking';
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

export function openTree(baseDir: string, features?: Config['features']) {
  return open({ scan: { include: ['**/*.md'] }, queries: {}, features, baseDir, configPath: null });
}

// For tests that need config beyond features (defaults, queries).
export function openConfig(cfg: Parameters<typeof open>[0]) {
  return open(cfg);
}
