import type { Feature } from './types.ts';

// sections(path, idx, level, heading, start_line, end_line, tokens): the heading outline,
// 1-indexed over the raw file so a row is a direct Read range; tokens is a chars/4 estimate.

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
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^(```|~~~)/.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = lines[i].match(/^(#{1,6}) +(.*)/);
    if (m) found.push({ level: m[1].length, heading: m[2].trim(), startLine: i + 1, endLine: lines.length, tokens: 0 });
  }
  for (let s = 0; s < found.length; s++) {
    if (s + 1 < found.length) found[s].endLine = found[s + 1].startLine - 1;
    const chars = lines.slice(found[s].startLine - 1, found[s].endLine).join('\n').length;
    found[s].tokens = Math.ceil(chars / 4);
  }
  return found;
}

export const sections: Feature = {
  name: 'sections',
  schema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS sections ("path" TEXT, idx INTEGER, level INTEGER, heading TEXT, start_line INTEGER, end_line INTEGER, tokens INTEGER, PRIMARY KEY ("path", idx))`);
  },
  extract,
  remove(db, path) {
    db.prepare('DELETE FROM sections WHERE "path" = ?').run(path);
  },
  store(db, path, extracted) {
    const insert = db.prepare('INSERT INTO sections ("path", idx, level, heading, start_line, end_line, tokens) VALUES (?, ?, ?, ?, ?, ?, ?)');
    (extracted as Section[]).forEach((s, idx) => insert.run(path, idx, s.level, s.heading, s.startLine, s.endLine, s.tokens));
  },
};
