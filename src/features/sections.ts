import type { Block } from '../chunk/index.ts';
import { estimateTokens, parse } from '../chunk/index.ts';
import { countLines } from '../scan/frontmatter.ts';
import type { Feature } from './types.ts';

// sections(path, idx, level, heading, start_line, end_line, tokens): the heading outline,
// 1-indexed over the raw file so a row is a direct Read range; tokens is estimateTokens (D5), CJK-aware.

export interface Section {
  level: number;
  heading: string;
  startLine: number;
  endLine: number;
  tokens: number;
}

// Heading blocks parse() already found (mdast/CommonMark fences), offset back onto the raw file;
// a section runs to just before the next heading, or EOF.
function sectionsFromBlocks(blocks: Block[], raw: string, body: string): Section[] {
  const rawLines = raw.split('\n');
  const offset = rawLines.length - countLines(body);
  const found: Section[] = blocks.filter((b) => b.type === 'heading').map((b) => ({ level: b.depth ?? 1, heading: (b.text ?? '').trim(), startLine: b.startLine + offset, endLine: rawLines.length, tokens: 0 }));
  for (let s = 0; s < found.length; s++) {
    if (s + 1 < found.length) found[s].endLine = found[s + 1].startLine - 1;
    const text = rawLines.slice(found[s].startLine - 1, found[s].endLine).join('\n');
    found[s].tokens = Math.ceil(estimateTokens(text));
  }
  return found;
}

export const sections: Feature = {
  name: 'sections',
  async schema(db) {
    await db.exec(`CREATE TABLE IF NOT EXISTS sections ("path" TEXT, idx INTEGER, level INTEGER, heading TEXT, start_line INTEGER, end_line INTEGER, tokens INTEGER, PRIMARY KEY ("path", idx))`);
  },
  extract(raw, body, _search, _data, _cfg, blocks) {
    return sectionsFromBlocks(blocks ?? parse(body), raw, body);
  },
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
