import { estimateTokens } from '../chunk/index.ts';
import { fenceTracker } from './fences.ts';
import type { Feature } from './types.ts';

// sections(path, idx, level, heading, start_line, end_line, tokens): the heading outline,
// 1-indexed over the raw file so a row is a direct Read range; tokens is estimateTokens (D5),
// CJK-aware rather than a flat chars/4.

export interface Section {
  level: number;
  heading: string;
  startLine: number;
  endLine: number;
  tokens: number;
}

// Headings outside fenced code blocks.
function extract(raw: string): Section[] {
  const lines = raw.split('\n');
  const found: Section[] = [];
  const fence = fenceTracker();
  for (let i = 0; i < lines.length; i++) {
    if (fence.feed(lines[i])) continue;
    if (fence.inFence) continue;
    const m = lines[i].match(/^(#{1,6}) +(.*)/);
    if (m) found.push({ level: m[1].length, heading: m[2].trim(), startLine: i + 1, endLine: lines.length, tokens: 0 });
  }
  for (let s = 0; s < found.length; s++) {
    if (s + 1 < found.length) found[s].endLine = found[s + 1].startLine - 1;
    const text = lines.slice(found[s].startLine - 1, found[s].endLine).join('\n');
    found[s].tokens = Math.ceil(estimateTokens(text));
  }
  return found;
}

export const sections: Feature = {
  name: 'sections',
  async schema(db) {
    await db.exec(`CREATE TABLE IF NOT EXISTS sections ("path" TEXT, idx INTEGER, level INTEGER, heading TEXT, start_line INTEGER, end_line INTEGER, tokens INTEGER, PRIMARY KEY ("path", idx))`);
  },
  extract,
  async remove(db, paths) {
    if (paths.length === 0) return;
    await db.runBatch(
      'DELETE FROM sections WHERE "path" = ?',
      paths.map((p) => [p])
    );
  },
  async store(db, docs) {
    const rows: unknown[][] = [];
    for (const { path, extracted } of docs) (extracted as Section[]).forEach((s, idx) => rows.push([path, idx, s.level, s.heading, s.startLine, s.endLine, s.tokens]));
    if (rows.length === 0) return;
    await db.runBatch('INSERT INTO sections ("path", idx, level, heading, start_line, end_line, tokens) VALUES (?, ?, ?, ?, ?, ?, ?)', rows);
  },
};
